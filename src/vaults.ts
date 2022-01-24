import { Connection, Account, Keypair } from '@solana/web3.js'
import { Provider, BN, Wallet } from '@project-serum/anchor'
import { Network, MAIN_NET, DEV_NET } from '@synthetify/sdk/lib/network'
import { Exchange, ExchangeState, Vault } from '@synthetify/sdk/lib/exchange'
import { ACCURACY, DEFAULT_PUBLIC_KEY } from '@synthetify/sdk/lib/utils'
import { Token, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { yellow } from 'colors'
import { Prices } from './prices'
import { Synchronizer } from './synchronizer'
import { fetchVaultEntries, fetchVaults } from './fetchers'
import { adjustVaultEntryInterestDebt, adjustVaultInterest, getAmountForLiquidation } from './math'
import { parsePriceData } from '@pythnetwork/client'
import { liquidateVault, vaultsToPrices } from './utils'

const insideCI = process.env.CI === 'true'
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

const { exchange: exchangeProgram } = MAIN_NET
let exchange: Exchange
let xUSDToken: Token
let state: Synchronizer<ExchangeState>

const main = async () => {
  console.log('Initialization')
  exchange = await Exchange.build(connection, NETWORK, provider.wallet)

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

  await loop()

  if (!insideCI) {
    setInterval(loop, 10 * 1000)
  } else {
    process.exit()
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
  const collateralPrices = await vaultsToPrices(vaults, connection)

  console.log('Calculating..')

  for (const entry of entries) {
    if (!vaults.has(entry.vault.toString())) continue

    const vault = vaults.get(entry.vault.toString()) as Vault
    const collateralPrice = collateralPrices.get(vault.collateralPriceFeed.toString()) ?? new BN(0)
    const syntheticPrice = prices.getPriceFor(vault.synthetic).val
    const amount = getAmountForLiquidation(entry, vault, collateralPrice, syntheticPrice)

    if (amount.val.eqn(0)) continue

    console.log('Found account for liquidation')
    console.log(amount.val.toString())

    await liquidateVault(
      amount,
      syntheticPrice,
      exchange,
      state.account,
      vault,
      entry,
      wallet,
      xUSDToken
    )
  }
  console.log(`Finished${insideCI ? '' : ' loop'}`)
}

main()
