import { Account, Keypair } from '@solana/web3.js'
import { Provider, Wallet } from '@project-serum/anchor'
import { Network } from '@synthetify/sdk/lib/network'
import { Exchange } from '@synthetify/sdk/lib/exchange'
import { sleep } from '@synthetify/sdk/lib/utils'
import { getConnection } from './utils'
import { vaultLoop } from './vaults'
import { stakingLoop } from './staking'
import { bs58 } from '@project-serum/anchor/dist/cjs/utils/bytes'

const NETWORK = Network.MAIN
const SCAN_INTERVAL = 1000 * 60 * 5

const insideCI = process.env.CI === 'true'
const secretWallet = new Wallet(
  insideCI
    ? Keypair.fromSecretKey(
        bs58.decode(
          '4s5o8GbjnMavvu7gvEuhH6hHc6HRs6GVWjK8bn1Eq7Pf5B7Fp7Y2R7gYUCj7yfubJtL9iBFozSaB44yAuU7PtWvB'
        )
      )
    : Keypair.generate()
)

const connection = getConnection(NETWORK)
const provider = insideCI
  ? new Provider(connection, secretWallet, { commitment: 'recent' })
  : Provider.local()

// @ts-expect-error
const wallet = provider.wallet.payer as Account

const main = async () => {
  console.log('Initialization')
  const exchange = await Exchange.build(connection, NETWORK, provider.wallet)
  await exchange.getState()

  console.log(`Using wallet: ${wallet.publicKey}`)

  await stakingLoop(exchange, wallet)
  await vaultLoop(exchange, wallet)

  if (!insideCI) {
    setInterval(() => stakingLoop(exchange, wallet), SCAN_INTERVAL)
    await sleep(SCAN_INTERVAL / 2)
    setInterval(() => vaultLoop(exchange, wallet), SCAN_INTERVAL)
  } else {
    process.exit()
  }
}

main()
