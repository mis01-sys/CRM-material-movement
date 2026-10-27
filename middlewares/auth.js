const { createHash } = require("node:crypto")
const AuthSession = require("../models/AuthSession")
const User = require("../models/User")
const { applyRolePermissionUpgrade } = require("../utils/permissions")

const SESSION_COOKIE = "sessionId"

const hashSessionId = (sessionId) => createHash("sha256").update(sessionId).digest("hex")
const clearSessionCookie = (res) => res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/"
})

const requireAuth = async (req, res, next) => {
    try {
        const sessionId = req.cookies && req.cookies[SESSION_COOKIE]
        if (!sessionId) {
            return res.status(401).json({ message: "Authentication required" })
        }

        const session = await AuthSession.findOne({
            sessionIdHash: hashSessionId(sessionId),
            expiresAt: { $gt: new Date() }
        })
        if (!session) {
            clearSessionCookie(res)
            return res.status(401).json({ message: "Session is invalid or expired" })
        }

        const user = applyRolePermissionUpgrade(await User.findById(session.userId))
        if (!user || !user.isActive) {
            await AuthSession.deleteOne({ _id: session._id })
            clearSessionCookie(res)
            return res.status(401).json({ message: "Account is inactive" })
        }

        req.user = user
        req.authSession = session
        return next()
    } catch (error) {
        return next(error)
    }
}

module.exports = { SESSION_COOKIE, clearSessionCookie, hashSessionId, requireAuth }
