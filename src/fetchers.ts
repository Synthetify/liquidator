import { Idl } from '@project-serum/anchor'
import { Connection, PublicKey, AccountInfo } from '@solana/web3.js'
import { ExchangeAccount, VaultEntry, Vault } from '@synthetify/sdk/lib/exchange'
import { IDL } from '@synthetify/sdk/lib/idl/exchange'
import { AccountsCoder, BN } from '@project-serum/anchor'

export const fetchExchangeAccounts = async (connection: Connection, exchangeProgram: PublicKey) => {
  const accounts = await connection.getProgramAccounts(exchangeProgram, {
    filters: [{ dataSize: 1412 + 8 }]
  })
  const coder = new AccountsCoder(IDL as Idl)

  return accounts.map(({ account }) => parseUser(account, coder))
}

export const fetchVaultEntries = async (connection: Connection, exchangeProgram: PublicKey) => {
  const accounts = await connection.getProgramAccounts(exchangeProgram, {
    filters: [{ dataSize: 116 + 8 }]
  })
  const coder = new AccountsCoder(IDL as Idl)

  return accounts.map(({ account }) => parseVaultEntry(account, coder))
}

export const fetchVaults = async (connection: Connection, exchangeProgram: PublicKey) => {
  const accounts = await connection.getProgramAccounts(exchangeProgram, {
    filters: [{ dataSize: 376 + 8 }]
  })
  const coder = new AccountsCoder(IDL as Idl)

  return accounts.map(({ account, pubkey }): Account<Vault> => {
    return {
      data: parseVault(account, coder),
      address: pubkey
    }
  })
}

export const parseUser = (account: AccountInfo<Buffer>, coder: AccountsCoder) =>
  coder.decode<ExchangeAccount>('exchangeAccount', account.data)

export const parseVaultEntry = (account: AccountInfo<Buffer>, coder: AccountsCoder) =>
  coder.decode<VaultEntry>('vaultEntry', account.data)

export const parseVault = (account: AccountInfo<Buffer>, coder: AccountsCoder) =>
  coder.decode<Vault>('vault', account.data)

export interface Account<T> {
  data: T
  address: PublicKey
}
