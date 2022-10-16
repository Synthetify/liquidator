import { Idl } from '@project-serum/anchor'
import { Connection, Account, PublicKey, Transaction } from '@solana/web3.js'
import { ExchangeAccount, AssetsList, ExchangeState, Exchange } from '@synthetify/sdk/lib/exchange'
import { AccountsCoder, BN } from '@project-serum/anchor'
import { calculateDebt, calculateUserMaxDebt, tou64, signAndSend } from '@synthetify/sdk/lib/utils'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  Token,
  TOKEN_PROGRAM_ID,
  AccountInfo
} from '@solana/spl-token'
import { Synchronizer } from './synchronizer'
import { blue, cyan, green, red } from 'colors'
import { parseUser } from './fetchers'
import { amountToValue, tenTo, valueToAmount } from './math'
import { parsePriceData } from '@pythnetwork/client'
import { VaultEntry, Vault, Decimal } from '@synthetify/sdk/lib/exchange'
import { DEFAULT_PUBLIC_KEY, toDecimal, ORACLE_OFFSET } from '@synthetify/sdk/lib/utils'
import { IDL } from '@synthetify/sdk/lib/idl/exchange'
import { Network } from '@synthetify/sdk'

export const U64_MAX = new BN('18446744073709551615')

export const isLiquidatable = (
  state: ExchangeState,
  assetsList: AssetsList,
  exchangeAccount: ExchangeAccount
) => {
  if (exchangeAccount.debtShares.eq(new BN(0))) return false

  const userMaxDebt = calculateUserMaxDebt(exchangeAccount, assetsList)
  const userDebt = calculateUserDebt(state, assetsList, exchangeAccount)
  return userDebt.gt(userMaxDebt)
}

export const calculateUserDebt = (
  state: ExchangeState,
  assetsList: AssetsList,
  exchangeAccount: ExchangeAccount
) => {
  const debt = calculateDebt(assetsList)
  return exchangeAccount.debtShares.mul(debt).div(state.debtShares)
}

export const createAccountsOnAllCollaterals = async (
  wallet: Account,
  connection: Connection,
  assetsList: AssetsList
) => {
  const addresses = assetsList.collaterals
    .map(({ collateralAddress }) => collateralAddress)
    .concat([assetsList.synthetics[0].assetAddress])

  const tokens = addresses.map(address => new Token(connection, address, TOKEN_PROGRAM_ID, wallet))
  const accounts = await Promise.all(
    tokens.map(token => token.getOrCreateAssociatedAccountInfo(wallet.publicKey))
  )

  // xUSD is just here for creation
  accounts.pop()

  return accounts.map(({ address }) => address)
}

export const liquidate = async (
  exchange: Exchange,
  exchangeAccount: Synchronizer<ExchangeAccount>,
  assetsList: AssetsList,
  state: ExchangeState,
  collateralAccounts: PublicKey[],
  wallet: Account,
  xUSDBalance: BN,
  xUSDAccountAddress: PublicKey
) => {
  if (!isLiquidatable(state, assetsList, exchangeAccount.account)) return false

  console.log(green('Liquidating..'))

  const liquidatedEntry = exchangeAccount.account.collaterals[0]
  const liquidatedCollateral = assetsList.collaterals[liquidatedEntry.index]
  const { liquidationRate } = state

  const debt = calculateUserDebt(state, assetsList, exchangeAccount.account)
  const maxLiquidate = debt.mul(liquidationRate.val).divn(10 ** liquidationRate.scale)
  // Taking .1% for debt change
  const amountNeeded = new BN(maxLiquidate).muln(999).divn(1000)

  if (xUSDBalance.lt(amountNeeded)) {
    if (xUSDBalance.eqn(0)) {
      console.error(red('xUSD Account is empty'))
      // throw Error('No xUSD in account')
      return false
    }
    console.error(red(`Amount of xUSD too low, using ${xUSDBalance.toString()}`))
  }

  const amount = amountNeeded.gt(xUSDBalance) ? xUSDBalance : U64_MAX

  const liquidatorCollateralAccount = collateralAccounts[liquidatedEntry.index]

  try {
    await exchange.liquidate({
      exchangeAccount: exchangeAccount.address,
      signer: wallet.publicKey,
      liquidationFund: liquidatedCollateral.liquidationFund,
      amount,
      liquidatorCollateralAccount,
      liquidatorUsdAccount: xUSDAccountAddress,
      reserveAccount: liquidatedCollateral.reserveAddress,
      signers: [wallet]
    })
  } catch (e) {
    console.error(e)
    return false
  }

  return true
}

export const getAccountsAtRisk = async (
  connection: Connection,
  exchange: Exchange,
  exchangeProgram: PublicKey,
  state: Synchronizer<ExchangeState>,
  assetsList: AssetsList
): Promise<UserWithAddress[]> => {
  // Fetching all account associated with the exchange, and size of 1420 (ExchangeAccount)
  console.log(`${cyan('Fetching accounts..')}`)
  console.time('fetching time')

  const accounts = await connection.getProgramAccounts(exchangeProgram, {
    filters: [{ dataSize: 1420 }]
  })

  console.timeEnd('fetching time')
  console.log(cyan(`Calculating debt for (${accounts.length}) accounts..`))
  console.time('calculating time')
  let atRisk: UserWithAddress[] = []
  let markedCounter = 0

  const coder = new AccountsCoder(IDL as Idl)

  for (const user of accounts) {
    const liquidatable = isLiquidatable(state.account, assetsList, parseUser(user.account, coder))
    if (liquidatable) {
      const exchangeAccount = parseUser(user.account, coder)
      atRisk.push({ address: user.pubkey, data: exchangeAccount })
    }
  }

  console.log('Done scanning accounts')
  console.timeEnd('calculating time')

  console.log(cyan(`Running check on liquidatable accounts..`))

  for (let user of atRisk) {
    // Set a deadline if not already set
    if (user.data.liquidationDeadline.eq(U64_MAX)) {
      await exchange.checkAccount(user.address)
      user = { address: user.address, data: await exchange.getExchangeAccount(user.address) }
      markedCounter++
    }
  }

  console.log(blue(`Found: ${atRisk.length} accounts at risk, and marked ${markedCounter} new`))
  return atRisk
}

export const vaultsToPrices = async (vaults: Map<string, Vault>, connection: Connection) => {
  vaults.forEach(v => {
    if (v.oracleType != 0)
      throw new Error('Oracle not supported on on this version, please update liquidator!')
  })

  const addresses = Array.from(vaults.values())
    .map(v => v.collateralPriceFeed)
    .filter((v, i, s) => s.indexOf(v) === i)
    .filter(v => !v.equals(DEFAULT_PUBLIC_KEY))

  const collateralPrices = new Map<string, BN>()
  collateralPrices.set(DEFAULT_PUBLIC_KEY.toString(), tenTo(ORACLE_OFFSET))

  const prices = await Promise.all(
    addresses.map(collateralPriceFeed => connection.getAccountInfo(collateralPriceFeed))
  )

  addresses.forEach((address, i) => {
    const account = prices[i]
    if (account === null) throw new Error("Couldn't fetch price")

    const { price } = parsePriceData(account.data)
    if (price === undefined) throw new Error("Couldn't fetch price")

    collateralPrices.set(address.toString(), new BN(price * 10 ** ORACLE_OFFSET))
  })

  return collateralPrices
}

export const getConnection = (network: Network) => {
  return network === Network.MAIN
    ? new Connection('https://solana-api.projectserum.com/', 'recent')
    : new Connection('https://psytrbhymqlkfrhudd.dev.genesysgo.net:8899', {
        wsEndpoint: 'wss://psytrbhymqlkfrhudd.dev.genesysgo.net:8900',
        commitment: 'recent'
      })
}

export interface UserWithAddress {
  address: PublicKey
  data: ExchangeAccount
}
