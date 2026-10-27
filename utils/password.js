const { promisify } = require("node:util")
const { randomBytes, scrypt: scryptCallback, timingSafeEqual } = require("node:crypto")

const scrypt = promisify(scryptCallback)
const KEY_LENGTH = 64

const hashPassword = async (password) => {
    const salt = randomBytes(16).toString("hex")
    const derivedKey = await scrypt(password, salt, KEY_LENGTH)
    return `${salt}:${derivedKey.toString("hex")}`
}

const verifyPassword = async (password, storedHash) => {
    const [salt, storedKeyHex] = storedHash.split(":")
    if (!salt || !storedKeyHex || !/^[a-f\d]+$/i.test(storedKeyHex)) {
        return false
    }

    const storedKey = Buffer.from(storedKeyHex, "hex")
    if (storedKey.length !== KEY_LENGTH) {
        return false
    }

    const derivedKey = await scrypt(password, salt, KEY_LENGTH)
    return timingSafeEqual(storedKey, derivedKey)
}

module.exports = { hashPassword, verifyPassword }
