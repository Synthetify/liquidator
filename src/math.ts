import { BN } from '@project-serum/anchor'
import { Decimal, Vault, VaultEntry } from '@synthetify/sdk/lib/exchange'
import { assert } from 'console'

const updateInterest = async (vault: Vault) => {
  const ADJUSTMENT_PERIOD = 60
  const timestamp = new BN(Date.now()).divn(1000)
  const diff = timestamp.sub(vault.lastUpdate).divn(ADJUSTMENT_PERIOD).toNumber()

  // const difTimestamp = Math.floor((Date.now() / 1000 - Number(vault.lastUpdate.toString())) / 60)
  const MINUTES_IN_YEAR = 525600

  if (diff >= 1) {
    const base = {
      val: vault.debtInterestRate.val
        .divn(MINUTES_IN_YEAR)
        .add(new BN(10).pow(new BN(vault.debtInterestRate.scale))),
      scale: vault.debtInterestRate.scale
    }

    // const timePeriodInterest = base.pow(new BN(diff))

    // const interestRate =
    //   Number(printBN(vault.debtInterestRate.val, vault.debtInterestRate.scale)) * 100
    // const minuteInterestRate = interestRate / MINUTES_IN_YEAR
    // const base = stringToMinDecimalBN(minuteInterestRate.toString())
    // const timePeriodInterest = base.BN.add(new BN(10).pow(new BN(base.decimal + 2))).pow(
    //   new BN(difTimestamp)
    // )
    //     const actualAccumulatedInterestRate = currentVault.accumulatedInterestRate.val
    //       .mul(timePeriodInterest)
    //       .div(new BN(10).pow(new BN(difTimestamp * (base.decimal + 2))))
    //     const diffAccumulate = actualAccumulatedInterestRate
    //       .mul(DENUMERATOR)
    //       .div(userVault.lastAccumulatedInterestRate.val)
    //     const currentDebt = userVault.syntheticAmount.val.mul(diffAccumulate).div(DENUMERATOR)
    //     yield put(
    //       actions.updateAmountSynthetic({
    //         syntheticAmount: { val: currentDebt, scale: userVault.syntheticAmount.scale },
    //         vault: userVault.vault
    //       })
    //     )
  }
}

const powDecimal = async (base: Decimal, exp: BN) => {
  const one = new BN(10).pow(new BN(base.scale))
}

const mulDecimal = async (first: Decimal, second: Decimal) => {
  assert()
}

export class Fixed {
  val: BN
  scale: number

  constructor(val: BN, scale: number) {
    this.val = val.muln(1) // copy
    this.scale = scale
  }

  static fromDecimal(decimal: Decimal) {
    return new Fixed(decimal.val, decimal.scale)
  }

  getDecimal() {
    return {
      val: this.val,
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

    while (fraction.length <= this.scale) fraction = '0' + fraction

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
