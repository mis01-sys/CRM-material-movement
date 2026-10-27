const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const assert = require("node:assert/strict")
const ejs = require("ejs")

const viewsDirectory = path.join(__dirname, "..", "views")

const findTemplates = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name)
    return entry.isDirectory() ? findTemplates(entryPath) : entry.name.endsWith(".ejs") ? [entryPath] : []
})

test("server-rendered EJS templates compile", () => {
    for (const template of findTemplates(viewsDirectory)) {
        assert.doesNotThrow(() => ejs.compile(fs.readFileSync(template, "utf8"), { filename: template }), template)
    }
})

test("every workspace page and record form renders with representative data", async () => {
    const id = "507f1f77bcf86cd799439011"
    const customer = { _id: id, customerUid: "AAAC001", name: "Example customer", contactPersonName: "Contact", mobile: "", email: "", address: "" }
    const item = { _id: id, partCode: "PART-1", description: "Example part", variant: "" }
    const stage = { _id: id, processName: "Cutting" }
    const order = {
        _id: id,
        poNo: "PO-1",
        customer,
        item,
        qtyPcs: 10,
        qtyKgs: 2,
        deliveryDate: new Date(),
        status: "OPEN",
        productionStages: [stage],
        completedStages: 0,
        workflowStatus: "NEW",
        lastExecutiveUpdate: null
    }
    const user = {
        id,
        username: "admin",
        role: "ADMIN",
        permissions: ["movements:read", "orders:read", "orders:write", "customers:read", "customers:write", "catalog:manage", "ledger:read", "ledger:write", "users:manage"]
    }
    const workspace = {
        role: "ADMIN",
        base: "/admin",
        sections: ["overview", "orders", "customers", "items", "stages", "ledger", "users", "settings"]
    }
    const defaultPermissions = {
        CRM: ["customers:read"],
        EXECUTIVE: ["orders:read"],
        ADMIN: ["users:manage"]
    }
    const common = {
        user,
        workspace,
        title: "Page",
        eyebrow: "TEST",
        description: "Representative data",
        nav: workspace.sections.map((key) => ({ key, title: key, active: false })),
        data: {
            metrics: { orderCount: 1, upcomingCount: 1, customerCount: 1, itemCount: 1, ledgerCount: 1, stageCount: 1 },
            users: [{ ...user, _id: id, isActive: true, lastLoginAt: null }],
            orders: [order],
            recentLedger: [],
            crmUpdates: [],
            customers: [customer],
            items: [item],
            stages: [stage],
            ledger: []
        },
        section: "overview",
        search: "",
        message: "",
        error: "",
        canWrite: true,
        canExport: true,
        formatDate: () => "Date",
        formatDateTime: () => "Date time",
        statusLabel: (value) => value,
        recordId: (value) => value?._id || value || "",
        permissionGroups: [{ label: "Customers", values: [["customers:read", "View customers"]] }],
        defaultPermissions,
        selectedPermissions: defaultPermissions.CRM,
        record: null,
        customers: [customer],
        items: [item],
        stages: [stage],
        orders: [{ ...order, nextStage: stage }]
    }

    for (const section of workspace.sections) {
        await ejs.renderFile(path.join(viewsDirectory, "workspace.ejs"), { ...common, section })
    }
    for (const section of ["customers", "items", "stages", "orders", "ledger", "users"]) {
        const record = section === "customers" ? customer
            : section === "items" ? item
                : section === "stages" ? stage
                    : section === "orders" ? order
                        : section === "users" ? { ...user, _id: id, isActive: true }
                            : null
        await ejs.renderFile(path.join(viewsDirectory, "record-form.ejs"), { ...common, section, record })
    }
})

test("page routes register with the installed Express router", () => {
    assert.doesNotThrow(() => require("../routes/pageRoutes"))
})
