const express = require("express")
const mongoose = require("mongoose")
const ExcelJS = require("exceljs")
const { randomBytes } = require("node:crypto")
const AuthSession = require("../models/AuthSession")
const Customer = require("../models/Customer")
const Item = require("../models/Item")
const Stage = require("../models/Stage")
const Order = require("../models/Order")
const Ledger = require("../models/Ledger")
const User = require("../models/User")
const { clearSessionCookie, hashSessionId, SESSION_COOKIE } = require("../middlewares/auth")
const { applyRolePermissionUpgrade, hasPermission, isValidPermissionSet, permissionsForRole, ROLE_PERMISSIONS } = require("../utils/permissions")
const { hashPassword, verifyPassword } = require("../utils/password")

const router = express.Router()
const MIN_PASSWORD_LENGTH = 12
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000
const ROLE_BASE = { ADMIN: "/admin", CRM: "/crm", EXECUTIVE: "/executive" }
const EXPORTABLE_SECTIONS = new Set(["orders", "customers", "items", "stages", "ledger", "users"])
const WORKSPACES = {
    admin: { role: "ADMIN", base: "/admin", sections: ["overview", "orders", "customers", "items", "stages", "ledger", "users", "settings"] },
    crm: { role: "CRM", base: "/crm", sections: ["overview", "orders", "customers", "items", "settings"] },
    executive: { role: "EXECUTIVE", base: "/executive", sections: ["overview", "orders", "customers", "settings"] }
}
const SECTION_INFO = {
    overview: ["Overview", "OPERATIONS", "A clear view of current orders, production and recent activity.", "movements:read"],
    orders: ["Orders", "CUSTOMER COMMITMENTS", "Track purchase orders, quantities, deadlines and production progress.", "orders:read"],
    customers: ["Customers", "CUSTOMER RELATIONSHIPS", "Keep customer contacts and order relationships in one place.", "customers:read"],
    items: ["Item catalog", "CATALOG", "Manage the parts used on customer orders.", "movements:read"],
    stages: ["Production stages", "WORKFLOW CONFIGURATION", "Define production processes available on order routes.", "movements:read"],
    ledger: ["Production ledger", "SHOP-FLOOR UPDATES", "A time-stamped record of each completed production stage.", "ledger:read"],
    users: ["User management", "ADMINISTRATION", "Create accounts and manage role assignments and permissions.", "users:manage"],
    settings: ["Settings", "ACCOUNT", "Update your account password.", null]
}
const EDIT_PERMISSIONS = {
    customers: "customers:write",
    orders: "orders:write",
    items: "catalog:manage",
    stages: "catalog:manage",
    ledger: "ledger:write",
    users: "users:manage"
}
const ADMIN_ONLY = new Set(["stages", "ledger", "users"])
const STATUS_LABELS = { NEW: "New", IN_PRODUCTION: "In production", COMPLETE: "Complete", ON_HOLD: "On hold" }
const PERMISSION_GROUPS = [
    { label: "Customers", values: [["customers:read", "View customers"], ["customers:write", "Manage customers"]] },
    { label: "Orders", values: [["orders:read", "View orders"], ["orders:write", "Manage orders"]] },
    { label: "Items & workflow", values: [["catalog:manage", "Manage items and stages"]] },
    { label: "Production", values: [["ledger:read", "View production ledger"], ["ledger:write", "Record production"]] },
    { label: "Administration", values: [["users:manage", "Manage users"]] },
    { label: "Other", values: [["movements:read", "View dashboard"], ["movements:write", "Edit movements"], ["purchases:read", "View purchases"], ["purchases:write", "Edit purchases"], ["reports:read", "View reports"]] }
]
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const isId = (value) => mongoose.Types.ObjectId.isValid(value)
const homeFor = (user) => ROLE_BASE[user.role] || "/login"
const canAccess = (user, permission) => !permission || hasPermission(user, permission)
const userView = (user) => ({ id: String(user._id), username: user.username, role: user.role, permissions: user.permissions })
const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next)
const returnTo = (res, path, key, value) => res.redirect(`${path}?${key}=${encodeURIComponent(value)}`)

const loadPageUser = async (req, res) => {
    const sessionId = req.cookies && req.cookies[SESSION_COOKIE]
    if (!sessionId) {
        res.redirect("/login")
        return null
    }
    const session = await AuthSession.findOne({
        sessionIdHash: hashSessionId(sessionId),
        expiresAt: { $gt: new Date() }
    })
    if (!session) {
        clearSessionCookie(res)
        res.redirect("/login")
        return null
    }
    const user = applyRolePermissionUpgrade(await User.findById(session.userId))
    if (!user || !user.isActive) {
        await AuthSession.deleteOne({ _id: session._id })
        clearSessionCookie(res)
        res.redirect("/login")
        return null
    }
    req.authSession = session
    return user
}

const guardWorkspace = (req, res, user, workspace, section) => {
    if (user.role !== workspace.role) {
        res.redirect(homeFor(user))
        return false
    }
    const info = SECTION_INFO[section]
    if (!info || !workspace.sections.includes(section) || !canAccess(user, info[3])) {
        res.redirect(homeFor(user))
        return false
    }
    return true
}

const guardEdit = (req, res, user, workspace, section) => {
    if (user.role !== workspace.role) {
        res.redirect(homeFor(user))
        return false
    }
    const executiveLedgerWrite = section === "ledger"
        && user.role === "EXECUTIVE"
        && hasPermission(user, "ledger:write")
    if ((!workspace.sections.includes(section) && !executiveLedgerWrite) || !SECTION_INFO[section]) {
        res.redirect(homeFor(user))
        return false
    }
    if (ADMIN_ONLY.has(section) && user.role !== "ADMIN" && !executiveLedgerWrite) {
        res.redirect(homeFor(user))
        return false
    }
    if (section === "customers" && !["ADMIN", "CRM"].includes(user.role)) {
        res.redirect(homeFor(user))
        return false
    }
    if (section === "orders" && !["ADMIN", "CRM"].includes(user.role)) {
        res.redirect(homeFor(user))
        return false
    }
    if (section === "items" && !["ADMIN", "CRM"].includes(user.role)) {
        res.redirect(homeFor(user))
        return false
    }
    const permission = EDIT_PERMISSIONS[section]
    if (!permission || !hasPermission(user, permission)) {
        res.redirect(homeFor(user))
        return false
    }
    return true
}

const enrichOrders = async (orders) => {
    const entries = orders.length ? await Ledger.find({ order: { $in: orders.map(({ _id }) => _id) } })
        .populate("stage", "processName").populate("createdBy", "username")
        .sort({ timestamp: -1, createdAt: -1 }).lean() : []
    const latestByOrder = new Map()
    for (const entry of entries) {
        const key = String(entry.order)
        if (!latestByOrder.has(key)) latestByOrder.set(key, entry)
    }
    return orders.map((order) => {
        const latest = latestByOrder.get(String(order._id))
        const stageIndex = latest ? order.productionStages.findIndex((stage) => String(stage._id) === String(latest.stage?._id)) : -1
        const completedStages = latest ? Math.max(0, stageIndex + 1) : 0
        const derived = completedStages >= order.productionStages.length ? "COMPLETE" : completedStages ? "IN_PRODUCTION" : "NEW"
        return {
            ...order,
            completedStages,
            workflowStatus: order.status === "ON_HOLD" ? "ON_HOLD" : derived,
            lastExecutiveUpdate: latest || null
        }
    })
}

const pageData = async (section, query, user, { exportAll = false } = {}) => {
    const search = typeof query.q === "string" ? query.q.trim() : ""
    const regex = search ? new RegExp(escapeRegex(search), "i") : null
    const listLimit = exportAll ? 0 : 250
    if (section === "overview") {
        const now = new Date()
        const [customerCount, itemCount, orderCount, stageCount, ledgerCount, upcomingCount, users, rawOrders, recentLedger] = await Promise.all([
            Customer.countDocuments(),
            Item.countDocuments(),
            Order.countDocuments(),
            Stage.countDocuments(),
            Ledger.countDocuments(),
            Order.countDocuments({ deliveryDate: { $gte: now } }),
            user.role === "ADMIN" ? User.find().select("username role isActive lastLoginAt").sort({ role: 1, username: 1 }).lean() : [],
            Order.find().populate("customer", "name customerUid").populate("item", "partCode description")
                .populate("productionStages", "processName").populate("crmUpdatedBy", "username")
                .sort({ deliveryDate: 1 }).limit(250).lean(),
            Ledger.find().populate("order", "poNo").populate("stage", "processName").populate("item", "partCode")
                .populate("createdBy", "username").sort({ timestamp: -1 }).limit(8).lean()
        ])
        const orders = await enrichOrders(rawOrders)
        const crmUpdates = orders.filter((order) => order.crmUpdatedBy)
            .sort((a, b) => new Date(b.crmUpdatedAt) - new Date(a.crmUpdatedAt)).slice(0, 8)
        return {
            metrics: { customerCount, itemCount, orderCount, stageCount, ledgerCount, upcomingCount },
            users,
            orders: orders.slice(0, 250),
            recentLedger,
            crmUpdates
        }
    }
    if (section === "customers") {
        const filter = regex ? { $or: [{ customerUid: regex }, { name: regex }, { mobile: regex }, { email: regex }, { contactPersonName: regex }] } : {}
        return { customers: await Customer.find(filter).sort({ name: 1 }).limit(listLimit).lean() }
    }
    if (section === "items") {
        const filter = regex ? { $or: [{ partCode: regex }, { description: regex }, { variant: regex }] } : {}
        return { items: await Item.find(filter).sort({ partCode: 1 }).limit(listLimit).lean() }
    }
    if (section === "stages") {
        const filter = regex ? { processName: regex } : {}
        return { stages: await Stage.find(filter).sort({ processName: 1 }).limit(listLimit).lean() }
    }
    if (section === "orders") {
        const filter = {}
        if (regex) {
            const [customers, items] = await Promise.all([
                Customer.find({ $or: [{ name: regex }, { customerUid: regex }] }).select("_id"),
                Item.find({ $or: [{ partCode: regex }, { description: regex }] }).select("_id")
            ])
            filter.$or = [{ poNo: regex }, { customer: { $in: customers.map(({ _id }) => _id) } }, { item: { $in: items.map(({ _id }) => _id) } }]
        }
        const rawOrders = await Order.find(filter).populate("customer", "name customerUid contactPersonName")
            .populate("item", "partCode description").populate("productionStages", "processName")
            .populate("crmUpdatedBy", "username").sort({ deliveryDate: 1 }).limit(listLimit).lean()
        return { orders: await enrichOrders(rawOrders) }
    }
    if (section === "ledger") {
        const filter = {}
        if (regex) {
            const [orders, stages, items] = await Promise.all([
                Order.find({ poNo: regex }).select("_id"),
                Stage.find({ processName: regex }).select("_id"),
                Item.find({ partCode: regex }).select("_id")
            ])
            filter.$or = [
                { order: { $in: orders.map(({ _id }) => _id) } },
                { stage: { $in: stages.map(({ _id }) => _id) } },
                { item: { $in: items.map(({ _id }) => _id) } }
            ]
        }
        return { ledger: await Ledger.find(filter).populate("order", "poNo").populate("stage", "processName")
            .populate("item", "partCode").populate("createdBy", "username").sort({ timestamp: -1 })
            .limit(exportAll ? 0 : 300).lean() }
    }
    if (section === "users") {
        const filter = regex ? { $or: [{ username: regex }, { role: regex }] } : {}
        return { users: await User.find(filter).sort({ username: 1 }).limit(listLimit).lean() }
    }
    return {}
}

const exportRows = (section, data) => {
    if (section === "customers") {
        return {
            sheetName: "Customers",
            columns: [
                { header: "Customer ID", key: "customerUid", width: 18 },
                { header: "Customer", key: "name", width: 30 },
                { header: "Contact person", key: "contactPersonName", width: 24 },
                { header: "Mobile", key: "mobile", width: 18 },
                { header: "Email", key: "email", width: 32 },
                { header: "Address", key: "address", width: 48 }
            ],
            rows: data.customers.map((customer) => customer)
        }
    }
    if (section === "items") {
        return {
            sheetName: "Items",
            columns: [
                { header: "Part code", key: "partCode", width: 20 },
                { header: "Description", key: "description", width: 48 },
                { header: "Variant", key: "variant", width: 24 }
            ],
            rows: data.items.map((item) => item)
        }
    }
    if (section === "stages") {
        return {
            sheetName: "Stages",
            columns: [
                { header: "Sequence", key: "sequence", width: 14 },
                { header: "Process name", key: "processName", width: 32 }
            ],
            rows: data.stages.map((stage, index) => ({ sequence: index + 1, processName: stage.processName }))
        }
    }
    if (section === "orders") {
        return {
            sheetName: "Orders",
            columns: [
                { header: "PO number", key: "poNo", width: 20 },
                { header: "Customer ID", key: "customerUid", width: 18 },
                { header: "Customer", key: "customerName", width: 30 },
                { header: "Contact person", key: "contactPersonName", width: 24 },
                { header: "Part code", key: "partCode", width: 18 },
                { header: "Item description", key: "itemDescription", width: 40 },
                { header: "Quantity (pcs)", key: "qtyPcs", width: 18 },
                { header: "Quantity (kg)", key: "qtyKgs", width: 18 },
                { header: "Delivery date", key: "deliveryDate", width: 18 },
                { header: "Status", key: "workflowStatus", width: 18 },
                { header: "Completed stages", key: "completedStages", width: 20 },
                { header: "Total stages", key: "totalStages", width: 16 },
                { header: "Last production update", key: "lastUpdateAt", width: 24 },
                { header: "Updated by", key: "lastUpdatedBy", width: 22 }
            ],
            rows: data.orders.map((order) => ({
                poNo: order.poNo,
                customerUid: order.customer?.customerUid || "",
                customerName: order.customer?.name || "",
                contactPersonName: order.customer?.contactPersonName || "",
                partCode: order.item?.partCode || "",
                itemDescription: order.item?.description || "",
                qtyPcs: order.qtyPcs,
                qtyKgs: order.qtyKgs,
                deliveryDate: order.deliveryDate,
                workflowStatus: STATUS_LABELS[order.workflowStatus] || order.workflowStatus,
                completedStages: order.completedStages,
                totalStages: order.productionStages.length,
                lastUpdateAt: order.lastExecutiveUpdate?.timestamp || null,
                lastUpdatedBy: order.lastExecutiveUpdate?.createdBy?.username || ""
            }))
        }
    }
    if (section === "ledger") {
        return {
            sheetName: "Production ledger",
            columns: [
                { header: "Timestamp", key: "timestamp", width: 24 },
                { header: "PO number", key: "poNo", width: 20 },
                { header: "Part code", key: "partCode", width: 18 },
                { header: "Stage completed", key: "stage", width: 28 },
                { header: "Quantity (pcs)", key: "qtyPcs", width: 18 },
                { header: "Quantity (kg)", key: "qtyKgs", width: 18 },
                { header: "Updated by", key: "createdBy", width: 22 }
            ],
            rows: data.ledger.map((entry) => ({
                timestamp: entry.timestamp,
                poNo: entry.order?.poNo || "",
                partCode: entry.item?.partCode || "",
                stage: entry.stage?.processName || "",
                qtyPcs: entry.qtyPcs,
                qtyKgs: entry.qtyKgs,
                createdBy: entry.createdBy?.username || ""
            }))
        }
    }
    if (section === "users") {
        return {
            sheetName: "Users",
            columns: [
                { header: "Username", key: "username", width: 24 },
                { header: "Role", key: "role", width: 18 },
                { header: "Status", key: "status", width: 16 },
                { header: "Last login", key: "lastLoginAt", width: 24 },
                { header: "Permissions", key: "permissions", width: 16 }
            ],
            rows: data.users.map((member) => ({
                username: member.username,
                role: member.role,
                status: member.isActive ? "Active" : "Inactive",
                lastLoginAt: member.lastLoginAt,
                permissions: (member.permissions || []).length
            }))
        }
    }
    throw new Error(`Unsupported export section: ${section}`)
}

const createExportWorkbook = (section, data) => {
    const { sheetName, columns, rows } = exportRows(section, data)
    const workbook = new ExcelJS.Workbook()
    workbook.creator = "AAA Fastener Material Movement Portal"
    const worksheet = workbook.addWorksheet(sheetName)
    worksheet.columns = columns
    worksheet.addRows(rows)
    worksheet.views = [{ state: "frozen", ySplit: 1 }]
    worksheet.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: Math.max(1, worksheet.rowCount), column: columns.length }
    }
    const header = worksheet.getRow(1)
    header.font = { bold: true, color: { argb: "FFFFFFFF" } }
    header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF245B45" } }
    worksheet.eachRow((row) => row.eachCell((cell) => {
        if (cell.value instanceof Date) cell.numFmt = "yyyy-mm-dd hh:mm"
    }))
    return workbook
}

const renderWorkspace = async (req, res, user, workspace, section) => {
    if (!guardWorkspace(req, res, user, workspace, section)) return
    const data = await pageData(section, req.query, user)
    const [title, eyebrow, description] = SECTION_INFO[section]
    const nav = workspace.sections.filter((key) => canAccess(user, SECTION_INFO[key][3]))
        .map((key) => ({ key, title: SECTION_INFO[key][0], active: key === section }))
    return res.render("workspace", {
        user: userView(user),
        workspace,
        section,
        title,
        eyebrow,
        description,
        nav,
        data,
        search: typeof req.query.q === "string" ? req.query.q : "",
        canExport: EXPORTABLE_SECTIONS.has(section) && canAccess(user, SECTION_INFO[section][3]),
        message: typeof req.query.message === "string" ? req.query.message : "",
        error: typeof req.query.error === "string" ? req.query.error : "",
        canWrite: hasPermission(user, EDIT_PERMISSIONS[section]),
        formatDate: (value) => value ? new Date(value).toLocaleDateString() : "—",
        formatDateTime: (value) => value ? new Date(value).toLocaleString() : "—",
        statusLabel: (value) => STATUS_LABELS[value] || value,
        recordId: (value) => value?._id ? String(value._id) : String(value || "")
    })
}

const loadFormData = async (section, id) => {
    const model = { customers: Customer, items: Item, stages: Stage, orders: Order, users: User }[section]
    if (id && !isId(id)) return { error: "Invalid record ID" }
    let record = id && model ? await model.findById(id).lean() : null
    if (id && !record) return { error: "Record not found" }
    if (section === "orders") {
        const [customers, items, stages] = await Promise.all([
            Customer.find().sort({ name: 1 }).lean(),
            Item.find().sort({ partCode: 1 }).lean(),
            Stage.find().sort({ processName: 1 }).lean()
        ])
        if (record) {
            const hasLedger = await Ledger.exists({ order: id })
            if (hasLedger) record = { ...record, locked: true }
        }
        return { record, customers, items, stages }
    }
    if (section === "ledger") {
        const orders = await Order.find({ status: "OPEN" }).populate("customer", "name")
            .populate("productionStages", "processName").sort({ deliveryDate: 1 }).lean()
        const entries = orders.length ? await Ledger.find({ order: { $in: orders.map((order) => order._id) } })
            .sort({ timestamp: -1, createdAt: -1 }).lean() : []
        const latest = new Map()
        for (const entry of entries) if (!latest.has(String(entry.order))) latest.set(String(entry.order), entry)
        const pendingOrders = orders.map((order) => {
            const last = latest.get(String(order._id))
            const lastIndex = last ? order.productionStages.findIndex((stage) => String(stage._id) === String(last.stage)) : -1
            const nextStage = order.productionStages[lastIndex + 1]
            return nextStage ? { ...order, nextStage } : null
        }).filter(Boolean)
        return { record, orders: pendingOrders }
    }
    return { record }
}

const formRender = (res, options) => {
    const nav = options.workspace.sections.filter((key) => canAccess(options.user, SECTION_INFO[key][3]))
        .map((key) => ({ key, title: SECTION_INFO[key][0] }))
    return res.render("record-form", {
        ...options,
        nav,
        error: options.error || "",
        permissionGroups: PERMISSION_GROUPS,
        defaultPermissions: ROLE_PERMISSIONS,
        selectedPermissions: options.record?.role === "ADMIN"
            ? ROLE_PERMISSIONS.ADMIN
            : options.record?.permissions || ROLE_PERMISSIONS.CRM,
        formatDate: (value) => value ? new Date(value).toISOString().slice(0, 10) : "",
        recordId: (value) => value?._id ? String(value._id) : String(value || "")
    })
}

router.get("/login", (req, res) => res.render("login", { error: "" }))
router.get("/", (req, res) => res.redirect("/login"))
router.post("/login", wrap(async (req, res) => {
    const { username, password } = req.body || {}
    if (typeof username !== "string" || typeof password !== "string") {
        return res.status(400).render("login", { error: "Username and password are required." })
    }
    const user = applyRolePermissionUpgrade(
        await User.findOne({ username: username.trim().toLowerCase() }).select("+passwordHash")
    )
    if (!user || !user.isActive || !(await verifyPassword(password, user.passwordHash))) {
        return res.status(401).render("login", { error: "Invalid username or password." })
    }

    user.lastLoginAt = new Date()
    await user.save()
    const existingSessionId = req.cookies && req.cookies[SESSION_COOKIE]
    if (existingSessionId) await AuthSession.deleteOne({ sessionIdHash: hashSessionId(existingSessionId) })
    const sessionId = randomBytes(32).toString("base64url")
    await AuthSession.create({
        sessionIdHash: hashSessionId(sessionId),
        userId: user._id,
        expiresAt: new Date(Date.now() + SESSION_DURATION_MS)
    })
    res.cookie(SESSION_COOKIE, sessionId, {
        httpOnly: true,
        sameSite: "strict",
        secure: process.env.NODE_ENV === "production",
        maxAge: SESSION_DURATION_MS,
        path: "/"
    })
    return res.redirect(homeFor(user))
}))
router.get("/app", wrap(async (req, res) => {
    const user = await loadPageUser(req, res)
    if (user) res.redirect(homeFor(user))
}))

router.post("/logout", wrap(async (req, res) => {
    const sessionId = req.cookies && req.cookies[SESSION_COOKIE]
    if (sessionId) await AuthSession.deleteOne({ sessionIdHash: hashSessionId(sessionId) })
    clearSessionCookie(res)
    res.redirect("/login")
}))

router.post("/settings/password", wrap(async (req, res) => {
    const user = await loadPageUser(req, res)
    if (!user) return
    const { currentPassword, newPassword, confirmPassword } = req.body
    if (typeof currentPassword !== "string" || typeof newPassword !== "string" || newPassword.length < MIN_PASSWORD_LENGTH) {
        return returnTo(res, `${homeFor(user)}/settings`, "error", `New password must be at least ${MIN_PASSWORD_LENGTH} characters`)
    }
    if (newPassword !== confirmPassword) return returnTo(res, `${homeFor(user)}/settings`, "error", "New passwords do not match")
    const account = await User.findById(user._id).select("+passwordHash")
    if (!account || !(await verifyPassword(currentPassword, account.passwordHash))) {
        return returnTo(res, `${homeFor(user)}/settings`, "error", "Current password is incorrect")
    }
    account.passwordHash = await hashPassword(newPassword)
    await account.save()
    await AuthSession.deleteMany({ userId: account._id, _id: { $ne: req.authSession._id } })
    return returnTo(res, `${homeFor(user)}/settings`, "message", "Password updated. Other active sessions were signed out.")
}))

for (const workspace of Object.values(WORKSPACES)) {
    const home = workspace.base
    router.get(home, wrap(async (req, res) => {
        const user = await loadPageUser(req, res)
        if (user) {
            if (user.role !== workspace.role) return res.redirect(homeFor(user))
            return renderWorkspace(req, res, user, workspace, "overview")
        }
    }))

    router.get(`${home}/:section`, wrap(async (req, res) => {
        const user = await loadPageUser(req, res)
        if (user) return renderWorkspace(req, res, user, workspace, req.params.section)
    }))

    router.get(`${home}/:section/export.xlsx`, wrap(async (req, res) => {
        const user = await loadPageUser(req, res)
        if (!user) return
        const { section } = req.params
        if (!EXPORTABLE_SECTIONS.has(section)) {
            return res.redirect(home)
        }
        if (!guardWorkspace(req, res, user, workspace, section)) return
        const data = await pageData(section, req.query, user, { exportAll: true })
        const workbook = createExportWorkbook(section, data)
        const buffer = await workbook.xlsx.writeBuffer()
        res.set({
            "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition": `attachment; filename="${section}.xlsx"`
        })
        return res.send(Buffer.from(buffer))
    }))

    router.get(`${home}/:section/new`, wrap(async (req, res) => {
        const user = await loadPageUser(req, res)
        if (!user) return
        const { section } = req.params
        if (!guardEdit(req, res, user, workspace, section)) return
        const formData = await loadFormData(section)
        if (formData.error) return returnTo(res, `${home}/${section}`, "error", formData.error)
        return formRender(res, { user: userView(user), workspace, section, ...formData })
    }))

    router.get(`${home}/:section/:id/edit`, wrap(async (req, res) => {
        const user = await loadPageUser(req, res)
        if (!user) return
        const { section, id } = req.params
        if (!guardEdit(req, res, user, workspace, section)) return
        const formData = await loadFormData(section, id)
        if (formData.error) return returnTo(res, `${home}/${section}`, "error", formData.error)
        return formRender(res, { user: userView(user), workspace, section, ...formData })
    }))

    router.post(`${home}/:section/:id/delete`, wrap(async (req, res) => {
        const user = await loadPageUser(req, res)
        if (!user) return
        const { section, id } = req.params
        if (!guardEdit(req, res, user, workspace, section)) return
        if (!isId(id)) return returnTo(res, `${home}/${section}`, "error", "Invalid record ID")
        if (section === "users") {
            if (String(user._id) === id) return returnTo(res, `${home}/users`, "error", "You cannot delete your own account")
            if (await Ledger.exists({ createdBy: id })) return returnTo(res, `${home}/users`, "error", "User has ledger history; deactivate the account instead")
            const deleted = await User.findByIdAndDelete(id)
            if (!deleted) return returnTo(res, `${home}/users`, "error", "User not found")
            await AuthSession.deleteMany({ userId: id })
        } else if (section === "customers") {
            if (await Order.exists({ customer: id })) return returnTo(res, `${home}/customers`, "error", "Customer is linked to existing orders")
            if (!await Customer.findByIdAndDelete(id)) return returnTo(res, `${home}/customers`, "error", "Customer not found")
        } else if (section === "items") {
            if (await Order.exists({ item: id })) return returnTo(res, `${home}/items`, "error", "Item is linked to existing orders")
            if (!await Item.findByIdAndDelete(id)) return returnTo(res, `${home}/items`, "error", "Item not found")
        } else if (section === "stages") {
            if (await Order.exists({ productionStages: id }) || await Ledger.exists({ stage: id })) {
                return returnTo(res, `${home}/stages`, "error", "Stage is referenced by an order or production entry")
            }
            if (!await Stage.findByIdAndDelete(id)) return returnTo(res, `${home}/stages`, "error", "Stage not found")
        } else if (section === "orders") {
            if (await Ledger.exists({ order: id })) return returnTo(res, `${home}/orders`, "error", "Orders with production activity cannot be deleted")
            if (!await Order.findByIdAndDelete(id)) return returnTo(res, `${home}/orders`, "error", "Order not found")
        } else {
            return returnTo(res, home, "error", "This record cannot be deleted")
        }
        return returnTo(res, `${home}/${section}`, "message", "Record deleted.")
    }))

    const saveRecord = wrap(async (req, res) => {
        const user = await loadPageUser(req, res)
        if (!user) return
        const section = req.params.section
        if (section === "settings") return res.redirect(`${home}/settings`)
        if (!guardEdit(req, res, user, workspace, section)) return
        const id = req.params.id
        if (id && !isId(id)) return returnTo(res, `${home}/${section}`, "error", "Invalid record ID")
        const body = req.body
        try {
            if (section === "customers") {
                if (typeof body.name !== "string" || !body.name.trim()) throw new Error("Customer name is required")
                if (body.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())) throw new Error("Enter a valid customer email address")
                const fields = { name: body.name, address: body.address, mobile: body.mobile, contactPersonName: body.contactPersonName, email: body.email }
                if (id) {
                    if (!await Customer.findByIdAndUpdate(id, fields, { runValidators: true })) throw new Error("Customer not found")
                }
                else await Customer.create(fields)
            } else if (section === "items") {
                if (typeof body.partCode !== "string" || !body.partCode.trim() || typeof body.description !== "string" || !body.description.trim()) {
                    throw new Error("Part code and description are required")
                }
                const fields = { partCode: body.partCode, description: body.description, variant: body.variant }
                if (id) {
                    if (!await Item.findByIdAndUpdate(id, fields, { runValidators: true })) throw new Error("Item not found")
                }
                else await Item.create(fields)
            } else if (section === "stages") {
                if (typeof body.processName !== "string" || !body.processName.trim()) throw new Error("Process name is required")
                if (id) {
                    if (!await Stage.findByIdAndUpdate(id, { processName: body.processName }, { runValidators: true })) throw new Error("Stage not found")
                }
                else await Stage.create({ processName: body.processName })
            } else if (section === "orders") {
                if (!id) {
                    const productionStages = Object.entries(body).filter(([key, value]) => key.startsWith("stageOrder_") && value !== "")
                        .sort((a, b) => Number(a[1]) - Number(b[1])).map(([key]) => key.slice("stageOrder_".length))
                    if (!body.poNo || !isId(body.customer) || !isId(body.item) ||
                        !Number.isFinite(Number(body.qtyPcs)) || Number(body.qtyPcs) < 0 ||
                        !Number.isFinite(Number(body.qtyKgs)) || Number(body.qtyKgs) < 0 ||
                        !body.deliveryDate || !productionStages.length ||
                        new Set(Object.entries(body).filter(([key, value]) => key.startsWith("stageOrder_") && value !== "").map(([, value]) => value)).size !== productionStages.length) {
                        throw new Error("Complete every order field and select a unique position for each required stage")
                    }
                    const [customer, item, stagesCount] = await Promise.all([
                        Customer.exists({ _id: body.customer }), Item.exists({ _id: body.item }),
                        Stage.countDocuments({ _id: { $in: productionStages } })
                    ])
                    if (!customer || !item || stagesCount !== productionStages.length) throw new Error("Select existing customer, item and production stages")
                    await Order.create({
                        poNo: body.poNo, customer: body.customer, item: body.item, qtyPcs: body.qtyPcs,
                        qtyKgs: body.qtyKgs, deliveryDate: body.deliveryDate, productionStages,
                        createdBy: user._id, updatedBy: user._id,
                        ...(user.role === "CRM" ? { crmUpdatedBy: user._id, crmUpdatedAt: new Date() } : {})
                    })
                } else {
                    const status = body.status
                    if (!["OPEN", "ON_HOLD"].includes(status)) throw new Error("Select a valid order status")
                    const hasProductionHistory = await Ledger.exists({ order: id })
                    if (hasProductionHistory) {
                        const updated = await Order.findByIdAndUpdate(id, {
                            status,
                            updatedBy: user._id,
                            ...(user.role === "CRM" ? { crmUpdatedBy: user._id, crmUpdatedAt: new Date() } : {})
                        }, { runValidators: true })
                        if (!updated) throw new Error("Order not found")
                        return returnTo(res, `${home}/${section}`, "message", "Order status updated.")
                    }
                    const productionStages = Object.entries(body).filter(([key, value]) => key.startsWith("stageOrder_") && value !== "")
                        .sort((a, b) => Number(a[1]) - Number(b[1])).map(([key]) => key.slice("stageOrder_".length))
                    if (!body.poNo || !isId(body.customer) || !isId(body.item) ||
                        !Number.isFinite(Number(body.qtyPcs)) || Number(body.qtyPcs) < 0 ||
                        !Number.isFinite(Number(body.qtyKgs)) || Number(body.qtyKgs) < 0 ||
                        !body.deliveryDate || !productionStages.length) throw new Error("Complete every order field")
                    const positions = Object.entries(body).filter(([key, value]) => key.startsWith("stageOrder_") && value !== "").map(([, value]) => value)
                    if (new Set(positions).size !== positions.length) throw new Error("Each production stage must have a unique position")
                    const [customer, item, stagesCount] = await Promise.all([
                        Customer.exists({ _id: body.customer }), Item.exists({ _id: body.item }),
                        Stage.countDocuments({ _id: { $in: productionStages } })
                    ])
                    if (!customer || !item || stagesCount !== productionStages.length) throw new Error("Select existing customer, item and production stages")
                    const updates = {
                        poNo: body.poNo, customer: body.customer, item: body.item, qtyPcs: body.qtyPcs,
                        qtyKgs: body.qtyKgs, deliveryDate: body.deliveryDate, productionStages, status, updatedBy: user._id
                    }
                    if (user.role === "CRM") Object.assign(updates, { crmUpdatedBy: user._id, crmUpdatedAt: new Date() })
                    if (!await Order.findByIdAndUpdate(id, updates, { runValidators: true })) throw new Error("Order not found")
                }
            } else if (section === "ledger") {
                const [orderId, stageId] = (body.nextStage || "").split("|")
                if (!isId(orderId) || !isId(stageId) ||
                    !Number.isFinite(Number(body.qtyPcs)) || Number(body.qtyPcs) < 0 ||
                    !Number.isFinite(Number(body.qtyKgs)) || Number(body.qtyKgs) < 0) {
                    throw new Error("Select a pending order stage and enter valid quantities")
                }
                const order = await Order.findById(orderId)
                if (!order) throw new Error("Order not found")
                if (order.status === "ON_HOLD") throw new Error("This order is on hold. Ask CRM to reopen it before recording production.")
                if (!order.productionStages.some((stage) => String(stage) === stageId)) throw new Error("Stage is not part of this order's production route")
                const prior = await Ledger.findOne({ order: orderId }).sort({ timestamp: -1, createdAt: -1 }).select("stage").lean()
                const expectedIndex = prior ? order.productionStages.findIndex((stage) => String(stage) === String(prior.stage)) + 1 : 0
                if (expectedIndex >= order.productionStages.length || String(order.productionStages[expectedIndex]) !== stageId) {
                    throw new Error("Production stages must be recorded in the order's configured sequence")
                }
                await Ledger.create({
                    order: order._id, stage: stageId, item: order.item, qtyKgs: body.qtyKgs,
                    qtyPcs: body.qtyPcs, createdBy: user._id
                })
            } else if (section === "users") {
                const permissions = Array.isArray(body.permissions) ? body.permissions : body.permissions ? [body.permissions] : []
                const role = body.role
                if (!id && (typeof body.username !== "string" || body.username.trim().length < 3 || body.username.trim().length > 64)) {
                    throw new Error("Username must be between 3 and 64 characters")
                }
                if (!["ADMIN", "CRM", "EXECUTIVE"].includes(role)) throw new Error("Select a valid user role")
                if (id) {
                    if (String(user._id) === id && (role !== "ADMIN" || body.isActive !== "true")) {
                        throw new Error("You cannot demote or deactivate your own administrator account")
                    }
                    if (!isValidPermissionSet(permissions)) throw new Error("Select a unique set of supported permissions")
                    if (String(user._id) === id && !permissions.includes("users:manage")) throw new Error("Keep user-management permission on your own account")
                    const updates = { role, permissions: permissionsForRole(role, permissions), isActive: body.isActive === "true" }
                    const target = await User.findByIdAndUpdate(id, updates, { new: true, runValidators: true })
                    if (!target) throw new Error("User not found")
                    if (!target.isActive) await AuthSession.deleteMany({ userId: target._id })
                } else {
                    if (typeof body.password !== "string" || body.password.length < MIN_PASSWORD_LENGTH) {
                        throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
                    }
                    if (!isValidPermissionSet(permissions)) throw new Error("Select a unique set of supported permissions")
                    await User.create({
                        username: body.username.trim().toLowerCase(),
                        passwordHash: await hashPassword(body.password),
                        role,
                        permissions: permissionsForRole(role, permissions)
                    })
                }
            } else {
                return returnTo(res, home, "error", "Unsupported form")
            }
        } catch (error) {
            if (error.code === 11000) return returnTo(res, `${home}/${section}`, "error", "That value is already in use")
            return returnTo(res, `${home}/${section}`, "error", error.message)
        }
        return returnTo(res, `${home}/${section}`, "message", "Changes saved.")
    })
    router.post(`${home}/:section`, saveRecord)
    router.post(`${home}/:section/:id`, saveRecord)
}

module.exports = router
