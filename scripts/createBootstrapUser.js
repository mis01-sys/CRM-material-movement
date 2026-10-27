const dotenv = require("dotenv")
const mongoose = require("mongoose")
const connectDB = require("../config/dbConfig")
const createBootstrapUser = require("../utils/createBootstrapUser")

dotenv.config()

const main = async () => {
    const [username, password, ...extraArgs] = process.argv.slice(2)
    if (!username || !password || extraArgs.length > 0) {
        throw new Error("Usage: npm run bootstrap-user -- <username> <password>")
    }

    await connectDB(process.env.MONGODB_URI)
    const created = await createBootstrapUser(username, password)
    if (created) {
        console.log(`Provisioned bootstrap ADMIN user "${username.trim().toLowerCase()}"`)
    } else {
        console.log(`User "${username.trim().toLowerCase()}" already exists; no changes made`)
    }
}

main()
    .catch((error) => {
        console.error("Bootstrap user creation failed:", error.message)
        process.exitCode = 1
    })
    .finally(async () => {
        await mongoose.disconnect()
    })
