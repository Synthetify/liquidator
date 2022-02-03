import { Account, Keypair } from '@solana/web3.js'
import { Provider, BN, Wallet } from '@project-serum/anchor'
import { Network, DEV_NET, MAIN_NET } from '@synthetify/sdk/lib/network'
import { Exchange, ExchangeAccount, ExchangeState } from '@synthetify/sdk/lib/exchange'
import { sleep } from '@synthetify/sdk/lib/utils'
import { Token, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import {
  liquidate,
  getAccountsAtRisk,
  createAccountsOnAllCollaterals,
  getConnection
} from './utils'
import { cyan, yellow } from 'colors'
import { Prices } from './prices'
import { Synchronizer } from './synchronizer'
import { vaultLoop } from './vaults'

const NETWORK = Network.MAIN
const SCAN_INTERVAL = 1000 * 5

const insideCI = process.env.CI === 'true'
const secretWallet = new Wallet(
  insideCI
    ? Keypair.fromSecretKey(
        new Uint8Array((process.env.PRIV_KEY ?? '').split(',').map(a => Number(a)))
      )
    : Keypair.generate()
)

const connection = getConnection(NETWORK)
const provider = insideCI
  ? new Provider(connection, secretWallet, { commitment: 'recent' })
  : Provider.local()

// @ts-expect-error
const wallet = provider.wallet.payer as Account
const { exchange: exchangeProgram } = NETWORK === Network.MAIN ? MAIN_NET : DEV_NET

const main = async () => {
  console.log('Initialization')
  const exchange = await Exchange.build(connection, NETWORK, provider.wallet)
  await exchange.getState()

  console.log(`Using wallet: ${wallet.publicKey}`)

  await stakingLoop(exchange, wallet)
  await vaultLoop(exchange, wallet)

  if (!insideCI) {
    setInterval(() => stakingLoop(exchange, wallet), SCAN_INTERVAL)
    await sleep(SCAN_INTERVAL / 2)
    setInterval(() => vaultLoop(exchange, wallet), SCAN_INTERVAL)
  } else {
    process.exit()
  }
}

const stakingLoop = async (exchange: Exchange, wallet: Account) => {
  const state = new Synchronizer<ExchangeState>(
    connection,
    exchange.stateAddress,
    'state',
    await exchange.getState()
  )
  const prices = await Prices.build(
    connection,
    await exchange.getAssetsList(state.account.assetsList)
  )
  const collateralAccounts = await createAccountsOnAllCollaterals(
    wallet,
    connection,
    prices.assetsList
  )

  const xUSDAddress = prices.assetsList.synthetics[0].assetAddress
  const xUSDToken = new Token(connection, xUSDAddress, TOKEN_PROGRAM_ID, wallet)
  let xUSDAccount = await xUSDToken.getOrCreateAssociatedAccountInfo(wallet.publicKey)

  // Fetching all accounts with debt over limit
  const atRisk = (
    await getAccountsAtRisk(connection, exchange, exchangeProgram, state, prices.assetsList)
  )
    .sort((a, b) => a.data.liquidationDeadline.cmp(b.data.liquidationDeadline))
    .map(fresh => {
      return new Synchronizer<ExchangeAccount>(
        connection,
        fresh.address,
        'ExchangeAccount',
        fresh.data
      )
    })

  const slot = new BN(await connection.getSlot())

  console.log(cyan(`Liquidating suitable accounts (${atRisk.length})..`))
  console.time('checking time')

  for (const exchangeAccount of atRisk) {
    // Users are sorted so we can stop checking if deadline is in the future
    if (slot.lt(exchangeAccount.account.liquidationDeadline)) break

    while (true) {
      const liquidated = await liquidate(
        exchange,
        exchangeAccount,
        prices.assetsList,
        state.account,
        collateralAccounts,
        wallet,
        xUSDAccount.amount,
        xUSDAccount.address
      )
      if (!liquidated) break
      xUSDAccount = await xUSDToken.getOrCreateAssociatedAccountInfo(wallet.publicKey)
    }
  }

  console.log('Finished checking')
  console.timeEnd('checking time')
}

main()
