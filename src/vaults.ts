import { Account, Transaction } from '@solana/web3.js'
import { BN } from '@project-serum/anchor'
import { Decimal, Exchange, ExchangeState, Vault, VaultEntry } from '@synthetify/sdk/lib/exchange'
import { signAndSend } from '@synthetify/sdk'
import { Token, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { Prices } from './prices'
import { fetchVaultEntries, fetchVaults } from './fetchers'
import {
  adjustVaultEntryInterestDebt,
  adjustVaultInterest,
  amountToValue,
  getAmountForLiquidation,
  valueToAmount
} from './math'
import { U64_MAX, vaultsToPrices } from './utils'
import { toDecimal, tou64 } from '@synthetify/sdk/lib/utils'

export const vaultLoop = async (exchange: Exchange, wallet: Account) => {
  const state = await exchange.getState()
  const { connection, programId: exchangeProgram } = exchange
  const prices = await Prices.build(connection, await exchange.getAssetsList(state.assetsList))

  // Fetching vaults and entries
  console.log('\nFetching vaults..')
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
    if (vault.collateral.toString() !== '6MeoZEcUMhAB788YXTQN4x7K8MnwSt6RHWsLkuq9GJb2') continue
    const collateralPrice = collateralPrices.get(vault.collateralPriceFeed.toString()) ?? new BN(0)
    const syntheticPrice = prices.getPriceFor(vault.synthetic).val
    const amount = getAmountForLiquidation(entry, vault, collateralPrice, syntheticPrice)

    const xUSDAddress = prices.assetsList.synthetics[0].assetAddress
    const xUSDToken = new Token(connection, xUSDAddress, TOKEN_PROGRAM_ID, wallet)

    if (amount.val.eqn(0)) continue

    console.log('Found account for liquidation')
    console.log(amount.val.toString())

    await liquidateVault(amount, syntheticPrice, exchange, state, vault, entry, wallet, xUSDToken)
  }
  console.log(`Finished checking vaults`)
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

  if (maxUserCanAfford.eqn(0)) throw new Error('not enough xUSD')

  const liquidationAmountLimited = maxUserCanAfford.lt(maxAmount.val)
  const amount = liquidationAmountLimited ? toDecimal(maxUserCanAfford, maxAmount.scale) : maxAmount

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
