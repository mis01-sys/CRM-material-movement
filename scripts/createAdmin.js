const readline = require("node:readline")
const mongoose = require("mongoose")
require("dotenv").config()

const connectDB = require("../config/dbConfig")
const User = require("../models/User")
const { hashPassword } = require("../utils/password")
const { ROLE_PERMISSIONS } = require("../utils/permissions")

const promptHidden = (label) => new Promise((resolve, reject) => {
    const { stdin, stdout } = process
    if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
        reject(new Error("Run npm run createadmin from an interactive terminal"))
        return
    }

    stdout.write(label)
    stdin.setEncoding("utf8")
    stdin.setRawMode(true)
    stdin.resume()

    let value = ""
    const cleanup = () => {
        stdin.off("data", onData)
        stdin.setRawMode(false)
        stdout.write("\n")
    }
    const onData = (input) => {
        for (const character of input) {
            if (character === "\u0003" || character === "\u0004") {
                cleanup()
                reject(new Error("Admin creation cancelled"))
                return
            }
            if (character === "\r" || character === "\n") {
                cleanup()
                resolve(value)
                return
            }
            if (character === "\u0008" || character === "\u007f") {
                value = value.slice(0, -1)
            } else if (character >= " ") {
                value += character
            }
        }
    }

    stdin.on("data", onData)
})

const promptUsername = () => new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question("Admin username: ", (username) => {
        rl.close()
        resolve(username)
    })
})

const main = async () => {
    if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
        throw new Error("Run npm run createadmin from an interactive terminal")
    }

    const username = (await promptUsername()).trim().toLowerCase()
    if (username.length < 3 || username.length > 64) {
        throw new Error("Username must be between 3 and 64 characters")
    }

    const password = await promptHidden("Admin password (12+ characters): ")
    if (password.length < 12) {
        throw new Error("Password must be at least 12 characters")
    }

    await connectDB(process.env.MONGODB_URI)
    const existingUser = await User.findOne({ username }).select("_id")
    if (existingUser) {
        throw new Error(`Username "${username}" already exists; no changes made`)
    }

    await User.create({
        username,
        passwordHash: await hashPassword(password),
        role: "ADMIN",
        permissions: [...ROLE_PERMISSIONS.ADMIN]
    })
    console.log(`Created ADMIN user "${username}"`)
}

main()
    .catch((error) => {
        console.error("Admin creation failed:", error.message)
        process.exitCode = 1
    })
    .finally(async () => {
        await mongoose.disconnect()
    })
