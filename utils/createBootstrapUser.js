const User = require("../models/User")
const { hashPassword } = require("./password")
const { ROLE_PERMISSIONS } = require("./permissions")

const createBootstrapUser = async (username, password) => {
    if (typeof username !== "string" || username.trim().length < 3 || username.trim().length > 64) {
        throw new Error("Username must be between 3 and 64 characters")
    }
    if (typeof password !== "string" || password.length < 12) {
        throw new Error("Password must be at least 12 characters")
    }

    const normalizedUsername = username.trim().toLowerCase()
    const existingUser = await User.findOne({ username: normalizedUsername })
    if (existingUser) {
        if (existingUser.role !== "ADMIN") {
            existingUser.role = "ADMIN"
            existingUser.permissions = [...ROLE_PERMISSIONS.ADMIN]
            await existingUser.save()
            return true
        }
        return false
    }

    await User.create({
        username: normalizedUsername,
        passwordHash: await hashPassword(password),
        role: "ADMIN",
        permissions: [...ROLE_PERMISSIONS.ADMIN]
    })
    return true
}

module.exports = createBootstrapUser
