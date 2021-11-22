import { Connection, Keypair, clusterApiUrl } from '@solana/web3.js'
import { Provider, BN } from '@project-serum/anchor'
import { Network, MAIN_NET } from '@synthetify/sdk/lib/network'
import { Exchange } from '@synthetify/sdk/lib/exchange'
import { calculateUserMaxDebt } from '@synthetify/sdk/lib/utils'
import { parseUser, calculateUserDebt } from '../src/utils'
import { Prices } from '../src/prices'

const NETWORK = Network.MAIN

const provider = Provider.local()
// @ts-expect-error
const wallet = provider.wallet.payer as Keypair
const connection = new Connection(clusterApiUrl('mainnet-beta'), 'confirmed')
const { exchange: exchangeProgram, exchangeAuthority } = MAIN_NET

const main = async () => {
  console.log('Initialization')
  const exchange = await Exchange.build(
    connection,
    NETWORK,
    provider.wallet,
    exchangeAuthority,
    exchangeProgram
  )

  const state = await exchange.getState()
  const assetsList = await exchange.getAssetsList(state.assetsList)
  const prices = new Prices(connection, await exchange.getAssetsList(state.assetsList))

  const accounts = await connection.getProgramAccounts(exchangeProgram, {
    filters: [{ dataSize: 1420 }]
  })

  const exchangeAccounts = accounts.map(({ account }) => {
    const exchangeAccount = parseUser(account)

    const userMaxDebt = calculateUserMaxDebt(exchangeAccount, assetsList)
    const userDebt = calculateUserDebt(state, assetsList, exchangeAccount)

    const colRatio = userMaxDebt.gtn(0) ? userDebt.muln(100).div(userMaxDebt) : undefined

    return {
      exchangeAccount,
      userMaxDebt: userMaxDebt,
      userDebt: userDebt,
      colRatio
    }
  })

  console.log('account closets to liquidation: ')
  const worstColRatio = exchangeAccounts
    .filter(({ colRatio }) => colRatio != undefined)
    .sort((a, b) => {
      return b.colRatio.sub(a.colRatio).toNumber()
    })
    .slice(0, 10)

  for (const { exchangeAccount, userMaxDebt, userDebt, colRatio } of worstColRatio) {
    console.log(`${userMaxDebt} / ${userDebt} = ${colRatio}%`)
  }

  const toxicAccounts = exchangeAccounts.filter(({ userMaxDebt, userDebt }) => {
    return userMaxDebt.lt(userDebt) && userDebt.gtn(0)
  })
  console.log('toxicAccounts: ')
  for (const { userMaxDebt, userDebt, colRatio } of toxicAccounts) {
    console.log(`${userMaxDebt} / ${userDebt} = ${colRatio}%`)
  }
}

main()
