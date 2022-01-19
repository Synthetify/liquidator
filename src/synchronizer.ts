import { AccountsCoder } from '@project-serum/anchor'
import { Idl } from '@project-serum/anchor/dist/idl'
import EXCHANGE_IDL from '@synthetify/sdk/src/idl/exchange.json'
import { AccountInfo, Connection, PublicKey } from '@solana/web3.js'

const coder = new AccountsCoder(EXCHANGE_IDL as Idl)

export class Synchronizer<T> {
  private connection: Connection
  private nameInIDL: string
  public address: PublicKey
  public account: T

  constructor(connection: Connection, address: PublicKey, nameInIDL: string, initialAccount: T) {
    this.connection = connection
    this.address = address
    this.nameInIDL = nameInIDL
    this.account = initialAccount

    this.connection.onAccountChange(this.address, data => this.updateFromAccountInfo(data))
  }

  public static async build<T>(connection: Connection, address: PublicKey, nameInIDL: string) {
    const initialAccount = await connection.getAccountInfo(address)

    const data = await connection.getAccountInfo(address)
    if (data == null) throw new Error('invalid account')
    if (initialAccount?.data == null) throw new Error('invalid account')

    const initialData = coder.decode<T>(nameInIDL, initialAccount.data)
    return new Synchronizer<T>(connection, address, nameInIDL, initialData)
  }

  private updateFromAccountInfo(account: AccountInfo<Buffer>) {
    this.account = coder.decode<T>(this.nameInIDL, account.data)
  }
}
