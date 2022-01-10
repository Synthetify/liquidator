import { Idl } from '@project-serum/anchor'
import { Connection, PublicKey, AccountInfo } from '@solana/web3.js'
import {
  ExchangeAccount,
  AssetsList,
  ExchangeState,
  Exchange,
  VaultEntry,
  Vault
} from '@synthetify/sdk/lib/exchange'
import EXCHANGE_IDL from '../exchange.json'
import { AccountsCoder, BN } from '@project-serum/anchor'

const coder = new AccountsCoder(EXCHANGE_IDL as Idl)

export const fetchExchangeAccounts = async (connection: Connection, exchangeProgram: PublicKey) => {
  const accounts = await connection.getProgramAccounts(exchangeProgram, {
    filters: [{ dataSize: 1412 + 8 }]
  })

  return accounts.map(({ account }) => parseUser(account))
}

export const fetchVaultEntries = async (connection: Connection, exchangeProgram: PublicKey) => {
  const accounts = await connection.getProgramAccounts(exchangeProgram, {
    filters: [{ dataSize: 116 + 8 }]
  })

  return accounts.map(({ account }) => parseVaultEntry(account))
}

export const fetchVaults = async (connection: Connection, exchangeProgram: PublicKey) => {
  const accounts = await connection.getProgramAccounts(exchangeProgram, {
    filters: [{ dataSize: 376 + 8 }]
  })

  return accounts.map(({ account, pubkey }): Account<Vault> => {
    return {
      data: parseVault(account),
      address: pubkey
    }
  })
}

export const parseUser = (account: AccountInfo<Buffer>) =>
  coder.decode<ExchangeAccount>('ExchangeAccount', account.data)

export const parseVaultEntry = (account: AccountInfo<Buffer>) =>
  coder.decode<VaultEntry>('VaultEntry', account.data)

export const parseVault = (account: AccountInfo<Buffer>) =>
  coder.decode<Vault>('Vault', account.data)

export interface Account<T> {
  data: T
  address: PublicKey
}
