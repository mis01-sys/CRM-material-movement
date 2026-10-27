const { randomBytes } = require("node:crypto")
const express = require("express")
const AuthSession = require("../models/AuthSession")
const User = require("../models/User")
const { hashPassword, verifyPassword } = require("../utils/password")
const { clearSessionCookie, hashSessionId, requireAuth, SESSION_COOKIE } = require("../middlewares/auth")
const { applyRolePermissionUpgrade } = require("../utils/permissions")

const router = express.Router()
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000

const cookieOptions = () => ({
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_DURATION_MS,
    path: "/"
})

router.post("/login", async (req, res, next) => {
    try {
        const { username, password } = req.body || {}
        if (typeof username !== "string" || typeof password !== "string") {
            return res.status(400).json({ message: "Username and password are required" })
        }

        const user = applyRolePermissionUpgrade(await User.findOne({ username: username.trim().toLowerCase() }).select("+passwordHash"))
        if (!user || !user.isActive || !(await verifyPassword(password, user.passwordHash))) {
            return res.status(401).json({ message: "Invalid username or password" })
        }

        user.lastLoginAt = new Date()
        await user.save()

        const currentSessionId = req.cookies && req.cookies[SESSION_COOKIE]
        if (currentSessionId) {
            await AuthSession.deleteOne({ sessionIdHash: hashSessionId(currentSessionId) })
        }
        const sessionId = randomBytes(32).toString("base64url")
        const expiresAt = new Date(Date.now() + SESSION_DURATION_MS)
        await AuthSession.create({ sessionIdHash: hashSessionId(sessionId), userId: user._id, expiresAt })
        res.cookie(SESSION_COOKIE, sessionId, cookieOptions())
        return res.json({
            user: {
                id: user.id,
                username: user.username,
                role: user.role,
                permissions: user.permissions,
                dashboardUrl: user.role === "ADMIN" ? "/admin" : user.role === "EXECUTIVE" ? "/executive" : "/crm"
            }
        })
    } catch (error) {
        return next(error)
    }
})

router.post("/logout", async (req, res, next) => {
    try {
        const sessionId = req.cookies && req.cookies[SESSION_COOKIE]
        if (sessionId) {
            await AuthSession.deleteOne({ sessionIdHash: hashSessionId(sessionId) })
        }
        clearSessionCookie(res)
        return res.status(204).end()
    } catch (error) {
        return next(error)
    }
})

router.get("/me", requireAuth, (req, res) => res.json({
    user: {
        id: req.user.id,
        username: req.user.username,
        role: req.user.role,
        permissions: req.user.permissions
    }
}))

router.patch("/password", requireAuth, async (req, res, next) => {
    try {
        const { currentPassword, newPassword } = req.body || {}
        if (typeof currentPassword !== "string" || typeof newPassword !== "string") {
            return res.status(400).json({ message: "Current and new passwords are required" })
        }
        if (newPassword.length < 12) {
            return res.status(400).json({ message: "New password must be at least 12 characters" })
        }
        const user = applyRolePermissionUpgrade(await User.findById(req.user._id).select("+passwordHash"))
        if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) {
            return res.status(400).json({ message: "Current password is incorrect" })
        }
        user.passwordHash = await hashPassword(newPassword)
        await user.save()
        await AuthSession.deleteMany({ userId: user._id, _id: { $ne: req.authSession._id } })
        return res.json({ message: "Password updated. Other active sessions have been signed out." })
    } catch (error) {
        return next(error)
    }
})

module.exports = router
