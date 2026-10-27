const test = require("node:test")
const assert = require("node:assert/strict")
const { hashPassword, verifyPassword } = require("../utils/password")

test("password hashes verify only the original password", async () => {
    const hash = await hashPassword("a-strong-password")

    assert.notEqual(hash, "a-strong-password")
    assert.equal(await verifyPassword("a-strong-password", hash), true)
    assert.equal(await verifyPassword("a-different-password", hash), false)
})

test("password verifier rejects malformed hashes", async () => {
    assert.equal(await verifyPassword("password", "invalid"), false)
})
