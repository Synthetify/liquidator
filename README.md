# Liquidator

This is a liquidator script for Synthetify

## How to setup your own liquidator

1. First fork this repository to your own account
2. You will need to go into your Phantom (or any other) wallet end export private key (preferably on a separate account).
3. Then go to your freshly forked repository -> Settings -> [Secrets](https://docs.github.com/en/actions/security-guides/encrypted-secrets)
4. Create a new secret named _PRIV_KEY_ and paste your private key here.
5. Then you can go into Actions tab and start your workflow

## Maintenance

To keep your liquidator running you will need to periodically check if it was drained from xUSD or SOL, deposit it if needed and withdraw your profits.

## Deploying locally

Script uses keypair from [Solana](https://docs.solana.com/cli/choose-a-cluster#configure-the-command-line-tool) and wallet provider from [Anchor](https://project-serum.github.io/anchor/tutorials/tutorial-0.html#generating-a-client).

Install dependencies using npm:

    npm i

also, **ts-node** has to be installed globally.

To run script use:

    npm start

or:

    ts-node ./src/index.ts

export ANCHOR_WALLET=~/.config/solana/id.json
while true; do npm run start; sleep 1; done
