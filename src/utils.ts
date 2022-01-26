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
  const accounts = await Promise.all(
    await assetsList.collaterals.map(({ collateralAddress }) => {
      const token = new Token(connection, collateralAddress, TOKEN_PROGRAM_ID, wallet)
      return token.getOrCreateAssociatedAccountInfo(wallet.publicKey)
    })
  )
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
  console.log(cyan('Fetching accounts..'))
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

export const liquidateVault = async (
  maxAmount: Decimal,
  syntheticPrice: BN,
  exchange: Exchange,
  state: ExchangeState,
  vault: Vault,
  entry: VaultEntry,
  wallet: Account,
  xUSDToken: Token
) => {
  const syntheticToken = new Token(exchange.connection, vault.synthetic, TOKEN_PROGRAM_ID, wallet)
  const collateralToken = new Token(exchange.connection, vault.collateral, TOKEN_PROGRAM_ID, wallet)

  const [xUSDAccount, syntheticAccount, collateralAccount] = await Promise.all([
    xUSDToken.getOrCreateAssociatedAccountInfo(wallet.publicKey),
    syntheticToken.getOrCreateAssociatedAccountInfo(wallet.publicKey),
    collateralToken.getOrCreateAssociatedAccountInfo(wallet.publicKey)
  ])

  const isUsdTheSynthetic = xUSDAccount.address.equals(syntheticAccount.address)

  const maxUserCanAfford = isUsdTheSynthetic
    ? xUSDAccount.amount
    : valueToAmount(xUSDAccount.amount, syntheticPrice, entry.syntheticAmount.scale)
        .val.muln(100)
        .divn(103)
        .add(syntheticAccount.amount)

  console.log('amount', xUSDAccount.amount.toString())
  console.log('token', syntheticToken.publicKey.toString())
  console.log('max', maxUserCanAfford.toString())
  console.log('price: ', syntheticPrice.toNumber())
  const liquidationAmountLimited = maxUserCanAfford.lt(maxAmount.val)

  const amount = liquidationAmountLimited ? toDecimal(maxUserCanAfford, maxAmount.scale) : maxAmount

  console.log('amount', amount.val.toString())
  console.log('liquidationAmountLimited', liquidationAmountLimited.toString())

  console.log('Preparing synthetic for liquidation..')

  let tx = new Transaction().add(await exchange.updatePricesInstruction(state.assetsList))

  // Swap to the right synthetic
  if (!isUsdTheSynthetic) {
    // needed value + 2% to account for swap fee and price fluctuations
    const neededAmount = toDecimal(
      amount.val.muln(102).divn(100).sub(syntheticAccount.amount),
      amount.scale
    )

    // Minimum amount that can be traded on synthetify
    const swapValue = amountToValue(neededAmount, syntheticPrice)
    const swapAmount = swapValue.gt(new BN(1000)) ? swapValue : new BN(1001)

    if (swapAmount.gt(xUSDAccount.amount)) throw new Error('not enough xUSD')

    if (swapAmount.gten(0)) {
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
          amount: liquidationAmountLimited ? xUSDAccount.amount : swapAmount,
          owner: wallet.publicKey,
          tokenFor: vault.synthetic,
          tokenIn: xUSDToken.publicKey,
          userTokenAccountFor: syntheticAccount.address,
          userTokenAccountIn: xUSDAccount.address
        })
      )
    }
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
      amount: liquidationAmountLimited ? amount.val : U64_MAX,
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

  await signAndSend(tx, [wallet], exchange.connection)
  console.log('Liquidated')
}

export const vaultsToPrices = async (vaults: Map<string, Vault>, connection: Connection) => {
  vaults.forEach(v => {
    if (v.oracleType != 0)
      throw new Error('Oracle not supported on on this version, please update liquidator')
  })

  const addresses = Array.from(vaults.values())
    .map(v => v.collateralPriceFeed)
    .filter((v, i, s) => s.indexOf(v) === i)
    .filter(v => v !== DEFAULT_PUBLIC_KEY)

  const collateralPrices = new Map<string, BN>()
  collateralPrices.set(DEFAULT_PUBLIC_KEY.toString(), tenTo(ORACLE_OFFSET))

  const prices = await Promise.all(
    addresses.map(collateralPriceFeed => connection.getAccountInfo(collateralPriceFeed))
  )

  if (prices.length != addresses.length) throw new Error('I am wrong about how map works')

  addresses.forEach((address, i) => {
    const account = prices[i]
    if (account === null) throw new Error("Couldn't fetch price")

    const { price } = parsePriceData(account.data)
    if (price === undefined) throw new Error("Couldn't fetch price")

    collateralPrices.set(address.toString(), new BN(price * 10 ** ORACLE_OFFSET))
  })

  return collateralPrices
}

export interface UserWithAddress {
  address: PublicKey
  data: ExchangeAccount
}
