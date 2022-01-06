import { BN } from '@project-serum/anchor'
import { assert } from 'chai'
import { Fixed } from '../src/math'

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

  it('pow', async () => {
    const scale = 8
    const denominator = new BN(10).pow(new BN(scale))
    const decimal = new Fixed(new BN(2).mul(denominator), 8)
    const exp = new BN(17)
    const result = decimal.pow(exp)
    const expected = new Fixed(new BN(131072).mul(denominator), 8)

    assert.equal(result.toString(), expected.toString())
  })
})
