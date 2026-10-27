const express = require("express")
const User = require("../models/User")
const AuthSession = require("../models/AuthSession")
const Ledger = require("../models/Ledger")
const { requireAuth } = require("../middlewares/auth")
const { requirePermission, requireRole } = require("../middlewares/authorization")
const { hashPassword } = require("../utils/password")
const { isValidPermissionSet, permissionsForRole, ROLE_PERMISSIONS } = require("../utils/permissions")

const router = express.Router()
const MIN_PASSWORD_LENGTH = 12
const MANAGED_ROLES = ["CRM", "EXECUTIVE", "ADMIN"]

const publicUser = (user) => ({
    id: user.id,
    username: user.username,
    role: user.role,
    permissions: user.permissions,
    isActive: user.isActive,
    lastLoginAt: user.lastLoginAt
})

router.use(requireAuth, requirePermission("users:manage"), requireRole("ADMIN"))

router.get("/", async (req, res, next) => {
    try {
        const users = await User.find().sort({ username: 1 })
        return res.json({ users: users.map(publicUser) })
    } catch (error) {
        return next(error)
    }
})

router.post("/", async (req, res, next) => {
    try {
        const { username, password, role, permissions } = req.body || {}
        if (typeof username !== "string" || username.trim().length < 3 || username.trim().length > 64) {
            return res.status(400).json({ message: "Username must be between 3 and 64 characters" })
        }
        if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
            return res.status(400).json({ message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` })
        }
        if (!MANAGED_ROLES.includes(role)) {
            return res.status(400).json({ message: `Role must be one of: ${MANAGED_ROLES.join(", ")}` })
        }
        if (permissions !== undefined && !isValidPermissionSet(permissions)) {
            return res.status(400).json({ message: "Permissions must be a unique list of supported permission names" })
        }

        const user = await User.create({
            username: username.trim().toLowerCase(),
            passwordHash: await hashPassword(password),
            role,
            permissions: permissionsForRole(role, permissions)
        })
        return res.status(201).json({ user: publicUser(user) })
    } catch (error) {
        if (error.code === 11000) {
            return res.status(409).json({ message: "Username already exists" })
        }
        return next(error)
    }
})

router.patch("/:userId", async (req, res, next) => {
    try {
        if (!User.base.Types.ObjectId.isValid(req.params.userId)) {
            return res.status(400).json({ message: "Invalid user ID" })
        }
        const { role, permissions, isActive } = req.body || {}
        if (String(req.user._id).toLowerCase() === req.params.userId.toLowerCase() && ((role !== undefined && role !== "ADMIN") || isActive === false)) {
            return res.status(409).json({ message: "You cannot demote or deactivate your own administrator account" })
        }
        const updates = {}
        const existingUser = permissions !== undefined ? await User.findById(req.params.userId) : null
        if (permissions !== undefined && !existingUser) {
            return res.status(404).json({ message: "User not found" })
        }
        if (role !== undefined) {
            if (!MANAGED_ROLES.includes(role)) {
                return res.status(400).json({ message: `Role must be one of: ${MANAGED_ROLES.join(", ")}` })
            }
            updates.role = role
            if (permissions === undefined) {
                updates.permissions = permissionsForRole(role, ROLE_PERMISSIONS[role])
            }
        }
        if (permissions !== undefined) {
            const targetRole = role === undefined ? existingUser.role : role
            if (!targetRole || !MANAGED_ROLES.includes(targetRole) || !isValidPermissionSet(permissions)) {
                return res.status(400).json({ message: "Permissions must be a unique list of supported permission names" })
            }
            if (String(req.user._id).toLowerCase() === req.params.userId.toLowerCase() && !permissions.includes("users:manage")) {
                return res.status(409).json({ message: "Keep user-management permission on your own administrator account" })
            }
            updates.permissions = permissionsForRole(targetRole, permissions)
        }
        if (isActive !== undefined) {
            if (typeof isActive !== "boolean") {
                return res.status(400).json({ message: "isActive must be a boolean" })
            }
            updates.isActive = isActive
        }
        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ message: "Provide a role, permissions, or isActive update" })
        }

        const user = await User.findByIdAndUpdate(req.params.userId, updates, { new: true, runValidators: true })
        if (!user) {
            return res.status(404).json({ message: "User not found" })
        }
        if (!user.isActive) {
            await AuthSession.deleteMany({ userId: user._id })
        }
        return res.json({ user: publicUser(user) })
    } catch (error) {
        return next(error)
    }
})

router.delete("/:userId", async (req, res, next) => {
    try {
        if (!User.base.Types.ObjectId.isValid(req.params.userId)) {
            return res.status(400).json({ message: "Invalid user ID" })
        }
        if (String(req.user._id).toLowerCase() === req.params.userId.toLowerCase()) {
            return res.status(409).json({ message: "You cannot delete your own account" })
        }
        if (await Ledger.exists({ createdBy: req.params.userId })) {
            return res.status(409).json({ message: "User is referenced by production ledger entries; deactivate the account instead" })
        }
        const user = await User.findByIdAndDelete(req.params.userId)
        if (!user) {
            return res.status(404).json({ message: "User not found" })
        }
        await AuthSession.deleteMany({ userId: user._id })
        return res.status(204).end()
    } catch (error) {
        return next(error)
    }
})

module.exports = router
