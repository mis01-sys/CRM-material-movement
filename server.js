const express = require("express")
const dotenv = require("dotenv")
const cookieParser = require("cookie-parser")
const connectDB = require("./config/dbConfig")
const User = require("./models/User")
const createBootstrapUser = require("./utils/createBootstrapUser")
const authRoutes = require("./routes/authRoutes")
const userRoutes = require("./routes/userRoutes")
const productionRoutes = require("./routes/productionRoutes")
const pageRoutes = require("./routes/pageRoutes")

dotenv.config()

const app = express()
app.use(express.json({ limit: "16kb" }))
app.use(express.urlencoded({ extended: false, limit: "16kb" }))
app.use(cookieParser())
app.set("view engine", "ejs")
app.set("views", require("node:path").join(__dirname, "views"))
app.use(express.static(require("node:path").join(__dirname, "public")))
app.use(pageRoutes)
app.use("/api/auth", authRoutes)
app.use("/api/users", userRoutes)
app.use("/api/production", productionRoutes)

app.get("/health", (req, res) => res.json({ status: "ok" }))

app.use((error, req, res, next) => {
    console.error(error)
    if (res.headersSent) {
        return next(error)
    }
    if (error instanceof SyntaxError && error.status === 400 && "body" in error) {
        return res.status(400).json({ message: "Invalid JSON request body" })
    }
    if (error.name === "ValidationError" || error.name === "CastError") {
        return res.status(400).json({ message: error.message })
    }
    if (error.code === 11000) {
        return res.status(409).json({ message: "A record with that unique value already exists" })
    }
    return res.status(500).json({ message: "Internal server error" })
})

const ensureBootstrapUserFromEnv = async () => {
    const { BOOTSTRAP_USERNAME: username, BOOTSTRAP_PASSWORD: password } = process.env
    if (!username && !password) {
        const existingUser = await User.exists({})
        if (existingUser) {
            console.log("Existing user found; skipping bootstrap user creation")
            return
        }
        throw new Error("No users exist. Set BOOTSTRAP_USERNAME and BOOTSTRAP_PASSWORD, or create an account with the bootstrap-user command")
    }
    if (!username || !password) {
        throw new Error("Set both BOOTSTRAP_USERNAME and BOOTSTRAP_PASSWORD to create the bootstrap user")
    }
    const created = await createBootstrapUser(username, password)
    if (created) {
        console.log(`Provisioned bootstrap administrator "${username.trim().toLowerCase()}"`)
    }
}

const startServer = async () => {
    await connectDB(process.env.MONGODB_URI)
    await ensureBootstrapUserFromEnv()
    const port = Number(process.env.PORT) || 3000
    app.listen(port, () => console.log(`Server listening on port ${port}`))
}

if (require.main === module) {
    startServer().catch((error) => {
        console.error("Server startup failed:", error)
        process.exitCode = 1
    })
}

module.exports = { app, startServer }