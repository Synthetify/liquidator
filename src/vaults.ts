import { Connection, Account, clusterApiUrl, PublicKey } from '@solana/web3.js'
import { Provider, BN } from '@project-serum/anchor'
import { Network, DEV_NET, MAIN_NET } from '@synthetify/sdk/lib/network'
import { Exchange, ExchangeState, Vault } from '@synthetify/sdk/lib/exchange'
import { ACCURACY, DEFAULT_PUBLIC_KEY, sleep, toDecimal } from '@synthetify/sdk/lib/utils'
import { ORACLE_OFFSET } from '@synthetify/sdk'
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

const XUSD_BEFORE_WARNING = new BN(100).pow(new BN(ACCURACY))
const CHECK_ALL_INTERVAL = 60 * 60 * 1000
const CHECK_AT_RISK_INTERVAL = 5 * 60 * 1000
const NETWORK = Network.DEV

const provider = Provider.local()
// @ts-expect-error
const wallet = provider.wallet.payer as Account
// const connection = new Connection('https://ssc-dao.genesysgo.net', 'recent')
const connection = new Connection('https://api.devnet.solana.com', 'recent')
const { exchange: exchangeProgram, exchangeAuthority } = DEV_NET
let exchange: Exchange
let xUSDToken: Token

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

  const state = new Synchronizer<ExchangeState>(
    connection,
    exchange.stateAddress,
    'State',
    await exchange.getState()
  )

  const prices = await Prices.build(
    connection,
    await exchange.getAssetsList(state.account.assetsList)
  )

  console.log('Assuring accounts on every collateral..')
  const collateralAccounts = await createAccountsOnAllCollaterals(
    wallet,
    connection,
    prices.assetsList
  )

  const xUSDAddress = prices.assetsList.synthetics[0].assetAddress
  xUSDToken = new Token(connection, xUSDAddress, TOKEN_PROGRAM_ID, wallet)
  let xUSDAccount = await xUSDToken.getOrCreateAssociatedAccountInfo(wallet.publicKey)

  if (xUSDAccount.amount.lt(XUSD_BEFORE_WARNING))
    console.warn(yellow(`Account is low on xUSD (${xUSDAccount.amount.toString()})`))

  await loop(prices)
}

const loop = async (prices: Prices) => {
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

    adjustVaultEntryInterestDebt(vaults.get(entry.vault.toString()), entry)
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

        const { price: fetchedPrice } = parsePriceData(account.data)

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

    const vault = vaults.get(entry.vault.toString())
    const collateralPrice = collateralPrices.get(vault.collateralPriceFeed.toString())
    const syntheticPrice = prices.getPriceFor(vault.synthetic).val
    const amount = getAmountForLiquidation(entry, vault, collateralPrice, syntheticPrice)

    if (amount.val.eqn(0)) continue

    console.log('Found account for liquidation')
    const syntheticToken = new Token(connection, vault.synthetic, TOKEN_PROGRAM_ID, wallet)
    const collateralToken = new Token(connection, vault.collateral, TOKEN_PROGRAM_ID, wallet)

    const [xUSDAccount, syntheticAccount, _] = await Promise.all([
      xUSDToken.getOrCreateAssociatedAccountInfo(wallet.publicKey),
      syntheticToken.getOrCreateAssociatedAccountInfo(wallet.publicKey),
      collateralToken.getOrCreateAssociatedAccountInfo(wallet.publicKey)
    ])

    console.log('Preparing synthetic for liquidation..')

    // needed value + 2% to account for swap fee and price fluctuations
    const value = amountToValue(amount, syntheticPrice)

    const neededAmount = toDecimal(
      amount.val.muln(101).divn(100).sub(syntheticAccount.amount),
      amount.scale
    )

    if (neededAmount.val.gten(0)) {
      console.log('Swapping synthetics..')

      const swapAmount = neededAmount.val.gt(new BN(1000)) ? neededAmount.val : new BN(1001)
      await exchange.swap({
        amount: swapAmount,
        owner: wallet.publicKey,
        tokenFor: vault.synthetic,
        tokenIn: xUSDToken.publicKey,
        userTokenAccountFor: syntheticAccount.address,
        userTokenAccountIn: xUSDAccount.address
      })
    }
    console.log('Liquidated')
  }

  console.log('Finished loop')
}

main()
