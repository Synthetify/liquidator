import { TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { Connection, Keypair, Transaction } from '@solana/web3.js'
import fetch from 'cross-fetch'

export const sellLoop = async (wallet: Keypair, connection: Connection) => {
  const userTokens = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
    programId: TOKEN_PROGRAM_ID
  })
  const xUSD = '83LGLCm7QKpYZbX8q4W2kYWbtt8NJBwbVwEepzkVnJ9y'
  const routesTx: any[] = []

  for (const tokenData of userTokens.value) {
    if (
      tokenData.account.data.parsed.info.tokenAmount.amount > 0 &&
      tokenData.account.data.parsed.info.mint !== xUSD
    ) {
      const mintAddress = tokenData.account.data.parsed.info.mint.toString()
      const amount = tokenData.account.data.parsed.info.tokenAmount.amount

      if (mintAddress === 'EzfgjvkSwthhgHaceR3LnKXUoRkP6NUhfghdaHAj1tUv') {
        // ftt zamienic na usdc
        console.log('FTT -> ', mintAddress, ' -> ', amount)
        continue
      }
      const { data } = await (
        await fetch(
          `https://quote-api.jup.ag/v3/quote?inputMint=${mintAddress}&outputMint=${xUSD}&amount=${amount}&slippageBps=${50}`
        )
      ).json()
      const routes = data
      if (routes) {
        // 2_000_000 = 2$
        if (routes[0].outAmount > 2_000_000 && routes[0].priceImpactPct * 100 < 0.5) {
          routesTx.push(routes[0])
        }
      }
    }
  }

  for (const routes of routesTx) {
    const transactions = await (
      await fetch('https://quote-api.jup.ag/v3/swap', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          route: routes,
          userPublicKey: wallet.publicKey.toString(),
          wrapUnwrapSOL: true
        })
      })
    ).json()

    const { setupTransaction, swapTransaction, cleanupTransaction } = transactions
    for (let serializedTransaction of [
      setupTransaction,
      swapTransaction,
      cleanupTransaction
    ].filter(Boolean)) {
      const transaction = Transaction.from(Buffer.from(serializedTransaction, 'base64'))
      const txid = await connection.sendTransaction(transaction, [wallet], {
        skipPreflight: true
      })
      await connection.confirmTransaction(txid)
      console.log(`https://solscan.io/tx/${txid}`)
    }
  }
}
