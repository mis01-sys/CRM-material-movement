const { hasPermission, PERMISSIONS, ROLES } = require("../utils/permissions")

const requirePermission = (...requiredPermissions) => {
    const unknownPermission = requiredPermissions.find((permission) => !PERMISSIONS.includes(permission))
    if (unknownPermission) {
        throw new Error(`Unknown permission: ${unknownPermission}`)
    }

    return (req, res, next) => {
        if (!req.user || !requiredPermissions.every((permission) => hasPermission(req.user, permission))) {
            return res.status(403).json({ message: "You do not have permission to perform this action" })
        }
        return next()
    }
}

const requireRole = (...allowedRoles) => {
    const unknownRole = allowedRoles.find((role) => !ROLES.includes(role))
    if (unknownRole) {
        throw new Error(`Unknown role: ${unknownRole}`)
    }

    return (req, res, next) => {
        if (!req.user || !allowedRoles.includes(req.user.role)) {
            return res.status(403).json({ message: "Your role is not allowed to perform this action" })
        }
        return next()
    }
}

module.exports = { requirePermission, requireRole }
