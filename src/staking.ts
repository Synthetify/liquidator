import { Account } from '@solana/web3.js'
import { BN } from '@project-serum/anchor'
import { Exchange, ExchangeAccount, ExchangeState } from '@synthetify/sdk/lib/exchange'
import { Token, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { liquidate, getAccountsAtRisk, createAccountsOnAllCollaterals } from './utils'
import { cyan } from 'colors'
import { Prices } from './prices'
import { Synchronizer } from './synchronizer'

export const stakingLoop = async (exchange: Exchange, wallet: Account) => {
  const { connection, programId: exchangeProgram } = exchange

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
