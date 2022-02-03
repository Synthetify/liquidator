import { Account } from '@solana/web3.js'
import { BN } from '@project-serum/anchor'
import { Exchange, Vault } from '@synthetify/sdk/lib/exchange'
import { Token, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { Prices } from './prices'
import { fetchVaultEntries, fetchVaults } from './fetchers'
import { adjustVaultEntryInterestDebt, adjustVaultInterest, getAmountForLiquidation } from './math'
import { liquidateVault, vaultsToPrices } from './utils'

export const vaultLoop = async (exchange: Exchange, wallet: Account) => {
  const state = await exchange.getState()
  const { connection, programId: exchangeProgram } = exchange
  const prices = await Prices.build(connection, await exchange.getAssetsList(state.assetsList))

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

    const xUSDAddress = prices.assetsList.synthetics[0].assetAddress
    const xUSDToken = new Token(connection, xUSDAddress, TOKEN_PROGRAM_ID, wallet)

    if (amount.val.eqn(0)) continue

    console.log('Found account for liquidation')
    console.log(amount.val.toString())

    await liquidateVault(amount, syntheticPrice, exchange, state, vault, entry, wallet, xUSDToken)
  }
  console.log(`Finished checking vaults`)
}

// main()
