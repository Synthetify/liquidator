import { TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { Account, Keypair } from '@solana/web3.js'
import { Provider, Wallet } from '@project-serum/anchor'
import { Network } from '@synthetify/sdk/lib/network'
import { sleep } from '@synthetify/sdk/lib/utils'
import { getConnection } from './utils'
import { bs58 } from '@project-serum/anchor/dist/cjs/utils/bytes'
import { sellLoop } from './sellTokens'

const NETWORK = Network.MAIN
const SCAN_INTERVAL = 1000 * 60 * 1

const insideCI = process.env.CI === 'true'
const secretWallet = new Wallet(
  insideCI ? Keypair.fromSecretKey(bs58.decode(process?.env?.PRIV_KEY ?? '')) : Keypair.generate()
)

const connection = getConnection(NETWORK)
const provider = insideCI
  ? new Provider(connection, secretWallet, { commitment: 'recent' })
  : Provider.local()

// @ts-expect-error
const wallet = provider.wallet.payer as Keypair

const main = async () => {
  console.log('Selling Initialization')
  console.log(`Using wallet: ${wallet.publicKey}`)

  await sellLoop(wallet, connection)
  if (!insideCI) {
    setInterval(() => sellLoop(wallet, connection), SCAN_INTERVAL)
    await sleep(SCAN_INTERVAL)
  } else {
    process.exit()
  }
}

main()
