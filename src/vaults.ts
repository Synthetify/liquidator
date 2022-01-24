import {
  Connection,
  Account,
  clusterApiUrl,
  PublicKey,
  Transaction,
  Keypair
} from '@solana/web3.js'
import { Provider, BN, Wallet } from '@project-serum/anchor'
import { Network, DEV_NET, MAIN_NET } from '@synthetify/sdk/lib/network'
import { Exchange, ExchangeState, Vault } from '@synthetify/sdk/lib/exchange'
import { ACCURACY, DEFAULT_PUBLIC_KEY, sleep, toDecimal, tou64 } from '@synthetify/sdk/lib/utils'
import { ORACLE_OFFSET, signAndSend } from '@synthetify/sdk'
import { Token, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { yellow } from 'colors'
import { Prices } from './prices'
import { Synchronizer } from './synchronizer'
import { fetchVaultEntries, fetchVaults } from './fetchers'
import {
  adjustVaultEntryInterestDebt,
  adjustVaultInterest,
  amountToValue,
  getAmountForLiquidation
} from './math'
import { parsePriceData } from '@pythnetwork/client'
import { U64_MAX } from './utils'

const insideCI = process.env.PRIV_KEY !== undefined

console.error(process.env.CI?.length)
console.error(process.env.PRIV_KEY?.length)
const secretWallet = new Wallet(
  insideCI
    ? Keypair.fromSecretKey(
        new Uint8Array((process.env.PRIV_KEY ?? '').split(',').map(a => Number(a)))
      )
    : Keypair.generate()
)

const XUSD_BEFORE_WARNING = new BN(100).pow(new BN(ACCURACY))
const NETWORK = Network.MAIN

const connection = new Connection('https://ssc-dao.genesysgo.net', 'recent')
// let connection = new Connection('https://psytrbhymqlkfrhudd.dev.genesysgo.net:8899', {
//   wsEndpoint: 'wss://psytrbhymqlkfrhudd.dev.genesysgo.net:8900',
//   commitment: 'recent'
// })
const provider = insideCI
  ? new Provider(connection, secretWallet, { commitment: 'recent' })
  : Provider.local()

// @ts-expect-error
const wallet = provider.wallet.payer as Account

const { exchange: exchangeProgram, exchangeAuthority } = MAIN_NET
let exchange: Exchange
let xUSDToken: Token
let state: Synchronizer<ExchangeState>

const main = async () => {
  console.log('Initialization')
  exchange = await Exchange.build(
    connection,
    NETWORK,
    provider.wallet,
    exchangeAuthority,
    exchangeProgram
  )

  await exchange.getState()

  state = new Synchronizer<ExchangeState>(
    connection,
    exchange.stateAddress,
    'State',
    await exchange.getState()
  )

  const prices = await Prices.build(
    connection,
    await exchange.getAssetsList(state.account.assetsList)
  )
  const xUSDAddress = prices.assetsList.synthetics[0].assetAddress
  xUSDToken = new Token(connection, xUSDAddress, TOKEN_PROGRAM_ID, wallet)
  let xUSDAccount = await xUSDToken.getOrCreateAssociatedAccountInfo(wallet.publicKey)

  if (xUSDAccount.amount.lt(XUSD_BEFORE_WARNING))
    console.warn(yellow(`Account is low on xUSD (${xUSDAccount.amount.toString()})`))

  if (insideCI) {
    await loop()
  } else {
    setInterval(loop, 10 * 1000)
  }
}

const loop = async () => {
  const prices = await Prices.build(
    connection,
    await exchange.getAssetsList(state.account.assetsList)
  )

  // Fetching vaults and entries
  console.log('Fetching vaults..')
  const entries = await fetchVaultEntries(connection, exchangeProgram)
  const fetchedVaults = await fetchVaults(connection, exchangeProgram)

  const vaults = new Map<string, Vault>()
  fetchedVaults.forEach(({ data: vault, address: vaultAddress }) => {
    adjustVaultInterest(vault)
    vaults.set(vaultAddress.toString(), vault)
  })

  // updating entries
  for (const entry of entries) {
    if (!vaults.has(entry.vault.toString())) continue

    adjustVaultEntryInterestDebt(vaults.get(entry.vault.toString()) as Vault, entry)
  }
  console.log(`Fetched ${entries.length} Entries from ${fetchedVaults.length} Vaults`)

  console.log('Fetching prices..')
  const collateralPrices = new Map<string, BN>()
  await Promise.all(
    Array.from(vaults.values()).map(async ({ oracleType, collateralPriceFeed }) => {
      if (oracleType != 0)
        throw new Error('Oracle not supported on on this version, please update liquidator')

      let price = 1
      if (!collateralPriceFeed.equals(DEFAULT_PUBLIC_KEY)) {
        const account = await connection.getAccountInfo(collateralPriceFeed)

        if (account === null) throw new Error("Couldn't fetch price")

        const { price: fetchedPrice } = parsePriceData(account.data)

        if (fetchedPrice === undefined) throw new Error("Couldn't fetch price")
        price = fetchedPrice
      }

      if (collateralPrices.has(collateralPriceFeed.toString())) return

      // checking again here because it could have changed while fetching
      if (collateralPrices.has(collateralPriceFeed.toString())) return
      collateralPrices.set(collateralPriceFeed.toString(), new BN(price * 10 ** ORACLE_OFFSET))
    })
  )

  console.log('Calculating..')
  let i = 0

  for (const entry of entries) {
    if (!vaults.has(entry.vault.toString())) continue

    const vault = vaults.get(entry.vault.toString()) as Vault
    const collateralPrice = collateralPrices.get(vault.collateralPriceFeed.toString()) as BN
    const syntheticPrice = prices.getPriceFor(vault.synthetic).val
    const amount = getAmountForLiquidation(entry, vault, collateralPrice, syntheticPrice)

    if (amount.val.eqn(0)) continue

    console.log(amount.val.toString())

    console.log('Found account for liquidation')
    const syntheticToken = new Token(connection, vault.synthetic, TOKEN_PROGRAM_ID, wallet)
    const collateralToken = new Token(connection, vault.collateral, TOKEN_PROGRAM_ID, wallet)

    const [xUSDAccount, syntheticAccount, collateralAccount] = await Promise.all([
      xUSDToken.getOrCreateAssociatedAccountInfo(wallet.publicKey),
      syntheticToken.getOrCreateAssociatedAccountInfo(wallet.publicKey),
      collateralToken.getOrCreateAssociatedAccountInfo(wallet.publicKey)
    ])

    const isUsdTheSynthetic = xUSDAccount.address.equals(syntheticAccount.address)

    console.log('Preparing synthetic for liquidation..')

    // needed value + 2% to account for swap fee and price fluctuations
    const neededAmount = toDecimal(
      amount.val.muln(102).divn(100).sub(syntheticAccount.amount),
      amount.scale
    )

    // Minimum amount that can be traded on synthetify
    const value = amountToValue(amount, syntheticPrice)
    const swapAmount = value.gt(new BN(1000)) ? value : new BN(1001)

    if (swapAmount.gt(xUSDAccount.amount)) throw new Error('not enough xUSD')

    let tx = new Transaction().add(await exchange.updatePricesInstruction(state.account.assetsList))

    // Swap to the right synthetic
    if (!isUsdTheSynthetic && neededAmount.val.gten(0)) {
      console.log('Swapping synthetics..')

      tx.add(
        Token.createApproveInstruction(
          TOKEN_PROGRAM_ID,
          xUSDAccount.address,
          exchange.exchangeAuthority,
          wallet.publicKey,
          [],
          tou64(U64_MAX)
        )
      )
      tx.add(
        await exchange.swapInstruction({
          amount: swapAmount,
          owner: wallet.publicKey,
          tokenFor: vault.synthetic,
          tokenIn: xUSDToken.publicKey,
          userTokenAccountFor: syntheticAccount.address,
          userTokenAccountIn: xUSDAccount.address
        })
      )
    }

    console.log('Liquidating..')

    tx.add(
      Token.createApproveInstruction(
        TOKEN_PROGRAM_ID,
        syntheticAccount.address,
        exchange.exchangeAuthority,
        wallet.publicKey,
        [],
        tou64(U64_MAX)
      )
    )

    // The liquidation itself
    tx.add(
      await exchange.liquidateVaultInstruction({
        amount: U64_MAX,
        collateral: vault.collateral,
        collateralReserve: vault.collateralReserve,
        liquidationFund: vault.liquidationFund,
        collateralPriceFeed: vault.collateralPriceFeed,
        synthetic: vault.synthetic,
        liquidator: wallet.publicKey,
        liquidatorCollateralAccount: collateralAccount.address,
        liquidatorSyntheticAccount: syntheticAccount.address,
        owner: entry.owner,
        vaultType: vault.vaultType
      })
    )

    await signAndSend(tx, [wallet], connection)
    console.log('Liquidated')
  }
  console.log(`Finished${insideCI ? '' : ' loop'}`)
}

main()
