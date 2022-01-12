import { Connection, Account, clusterApiUrl, PublicKey } from '@solana/web3.js'
import { Provider, BN } from '@project-serum/anchor'
import { Network, DEV_NET, MAIN_NET } from '@synthetify/sdk/lib/network'
import { Exchange, ExchangeState, Vault } from '@synthetify/sdk/lib/exchange'
import { ACCURACY, sleep } from '@synthetify/sdk/lib/utils'
import { ORACLE_OFFSET } from '@synthetify/sdk'
import { Token, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { createAccountsOnAllCollaterals } from './utils'
import { yellow } from 'colors'
import { Prices } from './prices'
import { Synchronizer } from './synchronizer'
import { fetchVaultEntries, fetchVaults } from './fetchers'
import { adjustVaultEntryInterestDebt, adjustVaultInterest, getAmountForLiquidation } from './math'
import { parsePriceData } from '@pythnetwork/client'

const XUSD_BEFORE_WARNING = new BN(100).pow(new BN(ACCURACY))
const CHECK_ALL_INTERVAL = 60 * 60 * 1000
const CHECK_AT_RISK_INTERVAL = 5 * 60 * 1000
const NETWORK = Network.MAIN

const provider = Provider.local()
// @ts-expect-error
const wallet = provider.wallet.payer as Account
const connection = new Connection('https://ssc-dao.genesysgo.net', 'recent')
const { exchange: exchangeProgram, exchangeAuthority } = MAIN_NET
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
  const entries = await fetchVaultEntries(connection, exchangeProgram)
  const fetchedVaults = await fetchVaults(connection, exchangeProgram)

  const vaults = new Map<string, Vault>()
  fetchedVaults.forEach(async ({ data: vault, address: vaultAddress }) => {
    adjustVaultInterest(vault)
    vaults.set(vaultAddress.toString(), vault)
  })

  // updating entries
  for (const entry of entries) {
    adjustVaultEntryInterestDebt(vaults.get(entry.vault.toString()), entry)
  }

  const collateralPrices = new Map<string, BN>()
  await Promise.all(
    Array.from(vaults.values()).map(async ({ oracleType, collateralPriceFeed }) => {
      if (oracleType != 0)
        throw new Error('Oracle not supported on on this version, please update liquidator')

      if (collateralPrices.has(collateralPriceFeed.toString())) return

      const account = await connection.getAccountInfo(collateralPriceFeed)
      const { price } = parsePriceData(account.data)

      // checking again here because it could have changed while fetching
      if (collateralPrices.has(collateralPriceFeed.toString())) return
      collateralPrices.set(collateralPriceFeed.toString(), new BN(price * 10 ** ORACLE_OFFSET))
    })
  )

  for (const entry of entries) {
    const vault = vaults.get(entry.vault.toString())
    const collateralPrice = collateralPrices.get(vault.collateralPriceFeed.toString())
    const syntheticPrice = prices.getPriceFor(vault.synthetic).val

    const amount = getAmountForLiquidation(entry, vault, collateralPrice, syntheticPrice)

    // if (amount.val.eqn(0)) return

    const syntheticToken = new Token(connection, vault.synthetic, TOKEN_PROGRAM_ID, wallet)
    const collateralToken = new Token(connection, vault.collateral, TOKEN_PROGRAM_ID, wallet)

    const [xUSDAccount, syntheticAccount, _] = await Promise.all([
      xUSDToken.getOrCreateAssociatedAccountInfo(wallet.publicKey),
      syntheticToken.getOrCreateAssociatedAccountInfo(wallet.publicKey),
      collateralToken.getOrCreateAssociatedAccountInfo(wallet.publicKey)
    ])

    // await exchange.swap({
    //   amount: amount.val,
    //   owner: wallet.publicKey,
    //   tokenFor: vault.synthetic,
    //   tokenIn: xUSDToken.publicKey,
    //   userTokenAccountFor: syntheticAccount.address,
    //   userTokenAccountIn: xUSDAccount.address
    // })
  }
}

main()
