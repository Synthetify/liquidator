import { BN } from '@project-serum/anchor'
import { assert } from 'chai'
import { adjustVaultEntryInterestDebt, Fixed, mulDecimal } from '../src/math'
import { Decimal, Synthetic, Vault, VaultEntry } from '@synthetify/sdk/lib/exchange'
import { PublicKey } from '@solana/web3.js'
import { adjustVaultInterest } from '../src/math'
import { toDecimal } from '@synthetify/sdk/lib/utils'

describe('Fixed', async () => {
  it('create', async () => {
    const decimal = new Fixed(new BN(111), 3)
    assert.equal(decimal.val.toString(), '111')
    assert.equal(decimal.scale, 3)
  })

  it('denominator', async () => {
    const decimal = new Fixed(new BN(111), 3)
    assert.equal(decimal.getDenominator().toString(), '1000')
  })

  it('getDecimal', async () => {
    const decimal = new Fixed(new BN(111), 3)
    assert.equal(decimal.getDecimal().val.toString(), '111')
    assert.equal(decimal.getDecimal().scale, 3)
  })

  it('add', () => {
    let decimal = new Fixed(new BN(1337), 6)
    let other = new Fixed(new BN(555), 6)
    let actual = decimal.add(other)
    let expected = new Fixed(new BN(1892), 6)

    assert.equal(actual.toString(), expected.toString())
  })

  it('multiply', async () => {
    const decimal = new Fixed(new BN(1234), 3)
    const by = new Fixed(new BN(4321), 5)
    const result = decimal.mul(by)
    const expected = new Fixed(new BN(53), 3)

    assert.equal(result.toString(), expected.toString())
  })

  it('decimal', async () => {
    const decimal = toDecimal(new BN(1234), 3)
    const by = toDecimal(new BN(4321), 5)
    const result = mulDecimal(decimal, by)
    const expected = toDecimal(new BN(53), 3)

    assert.equal(result.val.toString(), expected.val.toString())
    assert.equal(result.scale, expected.scale)
  })

  it('mulUp', () => {
    const a = new Fixed(new BN(2).pow(new BN(127)).subn(1), 12)
    const b = new Fixed(new BN('999999999999'), 12)
    const expected = new Fixed(new BN('170141183460299090548226834484152418424'), 12)
    assert.equal(a.mulUp(b).toString(), expected.toString())
  })

  it('pow', async () => {
    const scale = 8
    const denominator = new BN(10).pow(new BN(scale))
    const decimal = new Fixed(new BN(2).mul(denominator), 8)
    const exp = new BN(17)
    const result = decimal.pow(exp)
    const expected = new Fixed(new BN(131072).mul(denominator), 8)

    assert.equal(result.toString(), expected.toString())
  })

  it('adjust vault interest', async () => {
    const defaultPubkey = new PublicKey(0)
    const defaultDecimal: Decimal = {
      val: new BN(0),
      scale: 0
    }

    const vault: Vault = {
      debtInterestRate: {
        val: new BN('55000000000000000'),
        scale: 18
      },
      accumulatedInterestRate: {
        val: new BN(10).pow(new BN(18)),
        scale: 18
      },
      lastUpdate: new BN(0),
      halted: false,
      synthetic: defaultPubkey,
      collateral: defaultPubkey,
      collateralPriceFeed: defaultPubkey,
      oracleType: 0,
      openFee: defaultDecimal,
      collateralRatio: defaultDecimal,
      liquidationThreshold: defaultDecimal,
      liquidationRatio: defaultDecimal,
      liquidationPenaltyLiquidator: defaultDecimal,
      liquidationPenaltyExchange: defaultDecimal,
      accumulatedInterest: defaultDecimal,
      liquidationFund: defaultPubkey,
      collateralReserve: defaultPubkey,
      mintAmount: defaultDecimal,
      collateralAmount: defaultDecimal,
      maxBorrow: defaultDecimal,
      vaultType: 0
    }

    const timestamp = new BN(430)
    adjustVaultInterest(vault, timestamp)

    const expectedAccumulatedInterestRate: Decimal = {
      val: new BN('1000000732496424772'),
      scale: 18
    }

    const { accumulatedInterestRate } = vault

    assert.equal(
      accumulatedInterestRate.val.toString(),
      expectedAccumulatedInterestRate.val.toString()
    )
  })

  it('adjust vault interest', async () => {
    const defaultPubkey = new PublicKey(0)
    const defaultDecimal: Decimal = {
      val: new BN(0),
      scale: 0
    }

    const syntheticDebtPoolSupply = new Fixed(new BN('400000' + '000000'), 6)
    const syntheticBorrowedSupply = new Fixed(new BN('200010' + '000000'), 6)
    const syntheticTotalSupply = syntheticDebtPoolSupply.add(syntheticBorrowedSupply)
    const initialInterestRate = new Fixed(new BN(10).pow(new BN(18)), 18)

    const vault: Vault = {
      debtInterestRate: {
        val: new BN('55000000000000000'),
        scale: 18
      },
      accumulatedInterestRate: initialInterestRate.getDecimal(),
      lastUpdate: new BN(0),
      halted: false,
      synthetic: defaultPubkey,
      collateral: defaultPubkey,
      collateralPriceFeed: defaultPubkey,
      oracleType: 0,
      openFee: defaultDecimal,
      collateralRatio: defaultDecimal,
      liquidationThreshold: defaultDecimal,
      liquidationRatio: defaultDecimal,
      liquidationPenaltyLiquidator: defaultDecimal,
      liquidationPenaltyExchange: defaultDecimal,
      accumulatedInterest: defaultDecimal,
      liquidationFund: defaultPubkey,
      collateralReserve: defaultPubkey,
      mintAmount: defaultDecimal,
      collateralAmount: defaultDecimal,
      maxBorrow: defaultDecimal,
      vaultType: 0
    }

    const vaultEntry: VaultEntry = {
      lastAccumulatedInterestRate: initialInterestRate.getDecimal(),
      syntheticAmount: syntheticBorrowedSupply.getDecimal(),
      owner: defaultPubkey,
      vault: defaultPubkey,
      collateralAmount: defaultDecimal
    }

    const timestamp = new BN(430)

    adjustVaultInterest(vault, timestamp)
    adjustVaultEntryInterestDebt(vault, vaultEntry)
    const amountAfterAdjustment = Fixed.fromDecimal(vaultEntry.syntheticAmount)

    const expectedSupplyIncrease = new Fixed(new BN(146507), syntheticTotalSupply.scale)
    const expectedSyntheticBorrowedSupply = syntheticBorrowedSupply.add(expectedSupplyIncrease)

    assert.equal(amountAfterAdjustment.toString(), expectedSyntheticBorrowedSupply.toString())
  })
})
