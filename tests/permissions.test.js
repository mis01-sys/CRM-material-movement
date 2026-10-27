const test = require("node:test")
const assert = require("node:assert/strict")
const User = require("../models/User")
const { applyRolePermissionUpgrade, hasPermission, isValidPermissionSet, permissionsForRole, PERMISSIONS, ROLE_PERMISSIONS, ROLES } = require("../utils/permissions")

test("configured workspaces are CRM, executive, and administration", () => {
    assert.deepEqual(ROLES, ["CRM", "EXECUTIVE", "ADMIN"])
})

test("role permissions are supported and executive access is limited to production work", () => {
    for (const permissions of Object.values(ROLE_PERMISSIONS)) {
        assert.ok(permissions.every((permission) => PERMISSIONS.includes(permission)))
    }
    assert.ok(ROLE_PERMISSIONS.ADMIN.includes("users:manage"))
    assert.ok(ROLE_PERMISSIONS.EXECUTIVE.includes("ledger:write"))
    assert.ok(!ROLE_PERMISSIONS.EXECUTIVE.includes("users:manage"))
    assert.ok(!ROLE_PERMISSIONS.EXECUTIVE.includes("orders:write"))
})

test("user documents receive the selected role's default permissions", async () => {
    const user = new User({
        username: "crm-user",
        passwordHash: "hash",
        role: "CRM"
    })

    await user.validate()
    assert.deepEqual(user.permissions, ROLE_PERMISSIONS.CRM)
})

test("legacy accounts receive the permissions for their assigned workspace role", () => {
    const legacyExecutive = { role: "EXECUTIVE", permissions: ["movements:read", "movements:write", "purchases:read", "purchases:write", "reports:read", "users:manage"] }
    const customCrm = { role: "CRM", permissions: ["movements:read"] }

    assert.deepEqual(applyRolePermissionUpgrade(legacyExecutive).permissions, ROLE_PERMISSIONS.EXECUTIVE)
    assert.deepEqual(applyRolePermissionUpgrade(customCrm).permissions, ["movements:read"])
    assert.equal(applyRolePermissionUpgrade(null), null)
})

test("role upgrade preserves non-admin custom permission sets and applies defaults only when missing", () => {
    const customAdmin = { role: "ADMIN", permissions: ["customers:read"] }
    const missingPermissions = { role: "CRM" }
    const explicitlyEmpty = { role: "EXECUTIVE", permissions: [] }

    assert.deepEqual(applyRolePermissionUpgrade(customAdmin).permissions, ROLE_PERMISSIONS.ADMIN)
    assert.deepEqual(applyRolePermissionUpgrade(missingPermissions).permissions, ROLE_PERMISSIONS.CRM)
    assert.deepEqual(applyRolePermissionUpgrade(explicitlyEmpty).permissions, [])
})

test("admin accounts always have every supported permission", () => {
    const admin = applyRolePermissionUpgrade({ role: "ADMIN", permissions: ["customers:read"] })

    assert.ok(PERMISSIONS.every((permission) => hasPermission(admin, permission)))
    assert.deepEqual(permissionsForRole("ADMIN", ["customers:read"]), ROLE_PERMISSIONS.ADMIN)
})

test("purchasing accounts migrate into the CRM workspace", () => {
    const legacyPurchasing = { role: "PURCHASE", permissions: ["movements:read", "purchases:read", "purchases:write"] }
    assert.deepEqual(applyRolePermissionUpgrade(legacyPurchasing), {
        role: "CRM",
        permissions: ROLE_PERMISSIONS.CRM
    })
})

test("admin-managed custom permission sets accept supported unique permissions", () => {
    assert.equal(isValidPermissionSet(["customers:read", "orders:read"]), true)
    assert.equal(isValidPermissionSet(["customers:read", "customers:read"]), false)
    assert.equal(isValidPermissionSet(["not-a-permission"]), false)
    assert.equal(isValidPermissionSet("orders:read"), false)
})
