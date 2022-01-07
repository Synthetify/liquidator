import { BN } from '@project-serum/anchor'
import { Decimal, Synthetic, Vault, VaultEntry } from '@synthetify/sdk/lib/exchange'
import { assert } from 'console'

export const adjustVaultInterest = (
  vault: Vault,
  timestamp: BN = new BN(Date.now()).divn(1000)
) => {
  const ADJUSTMENT_PERIOD = 60
  const diff = timestamp.sub(vault.lastUpdate).divn(ADJUSTMENT_PERIOD).toNumber()
  const MINUTES_IN_YEAR = 525600

  if (diff >= 1) {
    const minuteInterestRate = vault.debtInterestRate.val.divn(MINUTES_IN_YEAR)
    const one = new BN(10).pow(new BN(vault.debtInterestRate.scale))
    const base = new Fixed(minuteInterestRate.add(one), vault.debtInterestRate.scale)
    const timePeriodInterest = base.pow(new BN(diff))

    vault.accumulatedInterestRate = Fixed.fromDecimal(vault.accumulatedInterestRate)
      .mul(timePeriodInterest)
      .getDecimal()
    vault.lastUpdate = new BN(diff).muln(ADJUSTMENT_PERIOD).add(vault.lastUpdate)
  }
}

export const adjustVaultEntryInterestDebt = (vault: Vault, entry: VaultEntry) => {
  const interestDenominator = Fixed.fromDecimal(entry.lastAccumulatedInterestRate)
  const interestNominator = Fixed.fromDecimal(vault.accumulatedInterestRate)

  if (interestDenominator.isEqual(interestNominator)) return

  const interestDebtDiff = interestNominator.div(interestDenominator)
  const newSyntheticAmount = Fixed.fromDecimal(entry.syntheticAmount).mulUp(interestDebtDiff)

  return newSyntheticAmount
}
export class Fixed {
  val: BN
  scale: number

  constructor(val: BN, scale: number) {
    this.val = val.clone()
    this.scale = scale
  }

  static fromDecimal(decimal: Decimal) {
    return new Fixed(decimal.val, decimal.scale)
  }

  getDecimal() {
    return {
      val: this.val.clone(),
      scale: this.scale
    }
  }

  getDenominator() {
    return new BN(10).pow(new BN(this.scale))
  }

  assertEqualScales(other: Fixed) {
    if (this.scale !== other.scale) {
      throw Error('Scales are not equal')
    }
  }

  isEqual(other: Fixed) {
    return this.val.eq(other.val) && this.scale === other.scale
  }

  toString() {
    const denominator = this.getDenominator()

    let fraction = this.val.mod(denominator).toString()

    while (fraction.length < this.scale) fraction = '0' + fraction

    return `${this.val.div(denominator).toString()}.${fraction}`
  }

  add(other: Fixed) {
    this.assertEqualScales(other)
    return new Fixed(this.val.add(other.val), this.scale)
  }

  sub(other: Fixed) {
    this.assertEqualScales(other)
    return new Fixed(this.val.sub(other.val), this.scale)
  }

  mul(other: Fixed) {
    return new Fixed(this.val.mul(other.val).div(other.getDenominator()), this.scale)
  }

  mulUp(other: Fixed) {
    return new Fixed(
      this.val.mul(other.val).add(other.getDenominator().subn(1)).div(other.getDenominator()),
      this.scale
    )
  }

  div(other: Fixed) {
    return new Fixed(this.val.mul(other.getDenominator()).div(other.val), this.scale)
  }

  pow(exp: BN) {
    const one = new Fixed(this.getDenominator(), this.scale)

    if (exp.eq(new BN(0))) {
      return one
    }

    let current_exp = exp
    let base = Fixed.fromDecimal(this.getDecimal())
    let result = one

    while (current_exp.gt(new BN(0))) {
      if (current_exp.modn(2) == 1) {
        result = result.mul(base)
      }
      current_exp = current_exp.divn(2)
      base = base.mul(base)
    }

    return result
  }
}
