const ROLES = Object.freeze(["CRM", "EXECUTIVE", "ADMIN"])

const PERMISSIONS = Object.freeze([
    "movements:read",
    "movements:write",
    "purchases:read",
    "purchases:write",
    "reports:read",
    "users:manage",
    "customers:read",
    "customers:write",
    "orders:read",
    "orders:write",
    "ledger:read",
    "ledger:write",
    "catalog:manage"
])

const ROLE_PERMISSIONS = Object.freeze({
    CRM: Object.freeze(["movements:read", "movements:write", "customers:read", "customers:write", "orders:read", "orders:write", "catalog:manage", "ledger:read"]),
    EXECUTIVE: Object.freeze(["movements:read", "customers:read", "orders:read", "ledger:read", "ledger:write"]),
    ADMIN: Object.freeze([...PERMISSIONS])
})

const LEGACY_PERMISSIONS = Object.freeze([
    "movements:read",
    "movements:write",
    "purchases:read",
    "purchases:write",
    "reports:read",
    "users:manage"
])

const isValidPermissionSet = (permissions) => Array.isArray(permissions)
    && new Set(permissions).size === permissions.length
    && permissions.every((permission) => PERMISSIONS.includes(permission))

const permissionsForRole = (role, permissions) => {
    if (role === "ADMIN") return [...ROLE_PERMISSIONS.ADMIN]
    const selected = Array.isArray(permissions) ? permissions : [...(ROLE_PERMISSIONS[role] || [])]
    return [...selected]
}

const hasPermission = (user, permission) => Boolean(
    user && (
        (user.role === "ADMIN" && PERMISSIONS.includes(permission))
        || user.permissions?.includes(permission)
    )
)

const applyRolePermissionUpgrade = (user) => {
    if (!user) return user
    if (user.role === "PURCHASE") {
        user.role = "CRM"
        user.permissions = [...ROLE_PERMISSIONS.CRM]
    }
    const permissions = user.permissions
    const isLegacyPermissionSet = Array.isArray(permissions)
        && permissions.length === LEGACY_PERMISSIONS.length
        && LEGACY_PERMISSIONS.every((permission) => permissions.includes(permission))
    if (ROLE_PERMISSIONS[user.role] && (!Array.isArray(permissions) || isLegacyPermissionSet)) {
        user.permissions = [...ROLE_PERMISSIONS[user.role]]
    }
    if (user.role === "ADMIN") {
        user.permissions = permissionsForRole("ADMIN", user.permissions)
    }
    return user
}

module.exports = {
    applyRolePermissionUpgrade,
    hasPermission,
    isValidPermissionSet,
    permissionsForRole,
    PERMISSIONS,
    ROLE_PERMISSIONS,
    ROLES
}
