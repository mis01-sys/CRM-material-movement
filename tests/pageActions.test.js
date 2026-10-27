const test = require("node:test")
const assert = require("node:assert/strict")
const ExcelJS = require("exceljs")
const { app } = require("../server")
const AuthSession = require("../models/AuthSession")
const User = require("../models/User")
const Item = require("../models/Item")
const Stage = require("../models/Stage")
const Customer = require("../models/Customer")
const Order = require("../models/Order")
const Ledger = require("../models/Ledger")
const { hashPassword } = require("../utils/password")

const startServer = async (t) => {
    const server = app.listen(0)
    await new Promise((resolve) => server.once("listening", resolve))
    t.after(() => new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
    }))
    return `http://127.0.0.1:${server.address().port}`
}

test("server-rendered item create, edit, search, and delete actions work", async (t) => {
    const userId = "507f1f77bcf86cd799439011"
    const itemId = "507f191e810c19729de860ea"
    const user = {
        _id: userId,
        username: "test-admin",
        role: "ADMIN",
        isActive: true,
        permissions: ["movements:read", "catalog:manage", "users:manage"]
    }
    const records = [{ _id: itemId, partCode: "PART-A", description: "Part A", variant: "A" }]
    const originals = {
        authFindOne: AuthSession.findOne,
        userFindById: User.findById,
        itemFind: Item.find,
        itemFindById: Item.findById,
        itemCreate: Item.create,
        itemUpdate: Item.findByIdAndUpdate,
        itemDelete: Item.findByIdAndDelete,
        orderExists: Order.exists,
        ledgerExists: Ledger.exists
    }
    t.after(() => {
        AuthSession.findOne = originals.authFindOne
        User.findById = originals.userFindById
        Item.find = originals.itemFind
        Item.findById = originals.itemFindById
        Item.create = originals.itemCreate
        Item.findByIdAndUpdate = originals.itemUpdate
        Item.findByIdAndDelete = originals.itemDelete
        Order.exists = originals.orderExists
        Ledger.exists = originals.ledgerExists
    })

    AuthSession.findOne = async () => ({ _id: "session-id", userId })
    User.findById = async () => user
    Item.find = () => ({ sort() { return this }, limit() { return this }, lean: async () => records })
    Item.findById = (id) => ({ lean: async () => records.find((record) => String(record._id) === id) || null })
    Item.create = async (fields) => {
        const record = { _id: "507f191e810c19729de860eb", ...fields }
        records.push(record)
        return record
    }
    Item.findByIdAndUpdate = async (id, fields) => {
        const record = records.find((entry) => String(entry._id) === id)
        if (record) Object.assign(record, fields)
        return record
    }
    Item.findByIdAndDelete = async (id) => {
        const index = records.findIndex((record) => String(record._id) === id)
        return index < 0 ? null : records.splice(index, 1)[0]
    }
    Order.exists = async () => null
    Ledger.exists = async () => null

    const baseUrl = await startServer(t)
    const headers = { cookie: "sessionId=test-session" }
    let response = await fetch(`${baseUrl}/admin/items`, { headers })
    assert.equal(response.status, 200)
    assert.match(await response.text(), /PART-A/)

    response = await fetch(`${baseUrl}/admin/items/new`, { headers })
    assert.equal(response.status, 200)
    assert.match(await response.text(), /name="partCode"/)

    response = await fetch(`${baseUrl}/admin/items`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ partCode: "PART-B", description: "Part B", variant: "B" }),
        redirect: "manual"
    })
    assert.equal(response.status, 302)
    assert.equal(records.length, 2)

    response = await fetch(`${baseUrl}/admin/items/${itemId}/edit`, { headers })
    assert.equal(response.status, 200)
    assert.match(await response.text(), /value="PART-A"/)

    response = await fetch(`${baseUrl}/admin/items/${itemId}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ partCode: "PART-C", description: "Updated part", variant: "C" }),
        redirect: "manual"
    })
    assert.equal(response.status, 302)
    assert.equal(records[0].partCode, "PART-C")

    response = await fetch(`${baseUrl}/admin/items?q=PART-C`, { headers })
    assert.equal(response.status, 200)
    const searchedPage = await response.text()
    assert.match(searchedPage, /PART-C/)
    assert.match(searchedPage, /items\/export\.xlsx\?q=PART-C/)

    response = await fetch(`${baseUrl}/admin/items/export.xlsx?q=PART-C`, { headers })
    assert.equal(response.status, 200)
    assert.match(response.headers.get("content-type"), /application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/)
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()))
    assert.equal(workbook.getWorksheet("Items").getCell("A2").value, "PART-C")

    response = await fetch(`${baseUrl}/admin/items/${itemId}/delete`, {
        method: "POST",
        headers,
        redirect: "manual"
    })
    assert.equal(response.status, 302)
    assert.equal(records.length, 1)
})

test("Excel exports require the same read permission as their data page", async (t) => {
    const userId = "507f1f77bcf86cd799439011"
    const user = {
        _id: userId,
        username: "customers-reader",
        role: "CRM",
        isActive: true,
        permissions: ["customers:read"]
    }
    const originals = {
        authFindOne: AuthSession.findOne,
        userFindById: User.findById
    }
    t.after(() => {
        AuthSession.findOne = originals.authFindOne
        User.findById = originals.userFindById
    })
    AuthSession.findOne = async () => ({ _id: "session-id", userId })
    User.findById = async () => user

    const baseUrl = await startServer(t)
    const headers = { cookie: "sessionId=test-session" }
    const response = await fetch(`${baseUrl}/crm/orders/export.xlsx`, { headers, redirect: "manual" })
    assert.equal(response.status, 302)
    assert.equal(response.headers.get("location"), "/crm")
})

test("login form posts credentials and creates a session without browser JavaScript", async (t) => {
    const userId = "507f1f77bcf86cd799439011"
    const user = {
        _id: userId,
        role: "ADMIN",
        username: "test-admin",
        isActive: true,
        permissions: ["users:manage"],
        passwordHash: await hashPassword("a-strong-test-password"),
        async save() {}
    }
    const originalFindOne = User.findOne
    const originalSessionCreate = AuthSession.create
    t.after(() => {
        User.findOne = originalFindOne
        AuthSession.create = originalSessionCreate
    })
    let session
    User.findOne = () => ({ select: async () => user })
    AuthSession.create = async (entry) => { session = entry; return entry }

    const baseUrl = await startServer(t)
    const response = await fetch(`${baseUrl}/login`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ username: "TEST-ADMIN", password: "a-strong-test-password" }),
        redirect: "manual"
    })
    assert.equal(response.status, 302)
    assert.equal(response.headers.get("location"), "/admin")
    assert.match(response.headers.get("set-cookie"), /sessionId=/)
    assert.equal(session.userId, userId)
})

test("admin can create, edit, and delete production stages", async (t) => {
    const userId = "507f1f77bcf86cd799439011"
    const stageId = "507f191e810c19729de860ea"
    const admin = {
        _id: userId,
        username: "test-admin",
        role: "ADMIN",
        isActive: true,
        permissions: []
    }
    const stages = [{ _id: stageId, processName: "Cutting" }]
    const originals = {
        authFindOne: AuthSession.findOne,
        userFindById: User.findById,
        stageFind: Stage.find,
        stageFindById: Stage.findById,
        stageCreate: Stage.create,
        stageUpdate: Stage.findByIdAndUpdate,
        stageDelete: Stage.findByIdAndDelete,
        orderExists: Order.exists,
        ledgerExists: Ledger.exists
    }
    t.after(() => {
        AuthSession.findOne = originals.authFindOne
        User.findById = originals.userFindById
        Stage.find = originals.stageFind
        Stage.findById = originals.stageFindById
        Stage.create = originals.stageCreate
        Stage.findByIdAndUpdate = originals.stageUpdate
        Stage.findByIdAndDelete = originals.stageDelete
        Order.exists = originals.orderExists
        Ledger.exists = originals.ledgerExists
    })

    AuthSession.findOne = async () => ({ _id: "session-id", userId })
    User.findById = async () => admin
    Stage.find = () => ({ sort() { return this }, limit() { return this }, lean: async () => stages })
    Stage.findById = (id) => ({ lean: async () => stages.find((stage) => String(stage._id) === id) || null })
    Stage.create = async (fields) => {
        const stage = { _id: "507f191e810c19729de860eb", ...fields }
        stages.push(stage)
        return stage
    }
    Stage.findByIdAndUpdate = async (id, fields) => {
        const stage = stages.find((entry) => String(entry._id) === id)
        if (stage) Object.assign(stage, fields)
        return stage
    }
    Stage.findByIdAndDelete = async (id) => {
        const index = stages.findIndex((entry) => String(entry._id) === id)
        return index < 0 ? null : stages.splice(index, 1)[0]
    }
    Order.exists = async () => null
    Ledger.exists = async () => null

    const baseUrl = await startServer(t)
    const headers = { cookie: "sessionId=test-session" }
    let response = await fetch(`${baseUrl}/admin/stages/new`, { headers })
    assert.equal(response.status, 200)
    assert.match(await response.text(), /name="processName"/)

    response = await fetch(`${baseUrl}/admin/stages`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ processName: "Forging" }),
        redirect: "manual"
    })
    assert.equal(response.status, 302)
    assert.equal(stages.length, 2)

    response = await fetch(`${baseUrl}/admin/stages/${stageId}/edit`, { headers })
    assert.equal(response.status, 200)
    assert.match(await response.text(), /value="Cutting"/)

    response = await fetch(`${baseUrl}/admin/stages/${stageId}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ processName: "Machining" }),
        redirect: "manual"
    })
    assert.equal(response.status, 302)
    assert.equal(stages[0].processName, "Machining")

    response = await fetch(`${baseUrl}/admin/stages/${stageId}/delete`, {
        method: "POST",
        headers,
        redirect: "manual"
    })
    assert.equal(response.status, 302)
    assert.equal(stages.length, 1)
})

test("admin user management create, edit, and delete actions work", async (t) => {
    const adminId = "507f1f77bcf86cd799439011"
    const memberId = "507f191e810c19729de860ea"
    const admin = {
        _id: adminId,
        username: "test-admin",
        role: "ADMIN",
        isActive: true,
        permissions: []
    }
    const member = {
        _id: memberId,
        username: "crm-member",
        role: "CRM",
        isActive: true,
        permissions: ["customers:read"]
    }
    const members = [member]
    const originals = {
        authFindOne: AuthSession.findOne,
        userFindById: User.findById,
        userFind: User.find,
        userCreate: User.create,
        userUpdate: User.findByIdAndUpdate,
        userDelete: User.findByIdAndDelete,
        sessionDeleteMany: AuthSession.deleteMany,
        ledgerExists: Ledger.exists
    }
    t.after(() => {
        AuthSession.findOne = originals.authFindOne
        User.findById = originals.userFindById
        User.find = originals.userFind
        User.create = originals.userCreate
        User.findByIdAndUpdate = originals.userUpdate
        User.findByIdAndDelete = originals.userDelete
        AuthSession.deleteMany = originals.sessionDeleteMany
        Ledger.exists = originals.ledgerExists
    })
    AuthSession.findOne = async () => ({ _id: "session-id", userId: adminId })
    User.findById = (id) => {
        if (String(id) === adminId) return Promise.resolve(admin)
        return { lean: async () => members.find((entry) => String(entry._id) === String(id)) || null }
    }
    User.find = () => ({ sort() { return this }, lean: async () => members })
    User.create = async (fields) => {
        const created = { _id: "507f191e810c19729de860eb", ...fields }
        members.push(created)
        return created
    }
    User.findByIdAndUpdate = async (id, updates) => {
        const target = members.find((entry) => String(entry._id) === String(id))
        if (target) Object.assign(target, updates)
        return target
    }
    User.findByIdAndDelete = async (id) => {
        const index = members.findIndex((entry) => String(entry._id) === String(id))
        return index < 0 ? null : members.splice(index, 1)[0]
    }
    AuthSession.deleteMany = async () => ({ deletedCount: 0 })
    Ledger.exists = async () => null

    const baseUrl = await startServer(t)
    const headers = { cookie: "sessionId=test-session" }
    let response = await fetch(`${baseUrl}/admin/users/${memberId}/edit`, { headers })
    assert.equal(response.status, 200)
    assert.match(await response.text(), /crm-member/)

    response = await fetch(`${baseUrl}/admin/users/${memberId}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams([
            ["role", "CRM"],
            ["isActive", "true"],
            ["permissions", "customers:read"],
            ["permissions", "orders:read"]
        ]),
        redirect: "manual"
    })
    assert.equal(response.status, 302)
    assert.deepEqual(member.permissions, ["customers:read", "orders:read"])

    response = await fetch(`${baseUrl}/admin/users`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams([
            ["username", "executive-member"],
            ["password", "a-strong-test-password"],
            ["role", "EXECUTIVE"],
            ["permissions", "orders:read"]
        ]),
        redirect: "manual"
    })
    assert.equal(response.status, 302)
    assert.equal(members.length, 2)
    assert.equal(members[1].username, "executive-member")

    response = await fetch(`${baseUrl}/admin/users/${memberId}/delete`, {
        method: "POST",
        headers,
        redirect: "manual"
    })
    assert.equal(response.status, 302)
    assert.equal(members.some((entry) => String(entry._id) === memberId), false)
})

test("production ledger form and action accept the next configured stage", async (t) => {
    const adminId = "507f1f77bcf86cd799439011"
    const orderId = "507f191e810c19729de860ea"
    const stageId = "507f191e810c19729de860eb"
    const admin = {
        _id: adminId,
        username: "test-admin",
        role: "ADMIN",
        isActive: true,
        permissions: []
    }
    let activeUser = admin
    const order = {
        _id: orderId,
        status: "OPEN",
        item: "507f191e810c19729de860ec",
        productionStages: [stageId]
    }
    const entries = []
    const originals = {
        authFindOne: AuthSession.findOne,
        userFindById: User.findById,
        orderFind: Order.find,
        orderFindById: Order.findById,
        ledgerFind: Ledger.find,
        ledgerFindOne: Ledger.findOne,
        ledgerCreate: Ledger.create
    }
    t.after(() => {
        AuthSession.findOne = originals.authFindOne
        User.findById = originals.userFindById
        Order.find = originals.orderFind
        Order.findById = originals.orderFindById
        Ledger.find = originals.ledgerFind
        Ledger.findOne = originals.ledgerFindOne
        Ledger.create = originals.ledgerCreate
    })
    AuthSession.findOne = async () => ({ _id: "session-id", userId: adminId })
    User.findById = async () => activeUser
    Order.find = () => ({
        populate() { return this },
        sort() { return this },
        lean: async () => [{ ...order, poNo: "PO-1", customer: { name: "Customer" }, productionStages: [{ _id: stageId, processName: "Cutting" }] }]
    })
    Order.findById = async () => order
    Ledger.find = () => ({ sort() { return this }, lean: async () => [] })
    Ledger.findOne = () => ({ sort() { return this }, select() { return this }, lean: async () => null })
    Ledger.create = async (entry) => { entries.push(entry); return entry }

    const baseUrl = await startServer(t)
    const headers = { cookie: "sessionId=test-session" }
    let response = await fetch(`${baseUrl}/admin/ledger/new`, { headers })
    assert.equal(response.status, 200)
    assert.match(await response.text(), new RegExp(`${orderId}\\\\|${stageId}`))

    response = await fetch(`${baseUrl}/admin/ledger`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            nextStage: `${orderId}|${stageId}`,
            qtyPcs: "25",
            qtyKgs: "4.5"
        }),
        redirect: "manual"
    })
    assert.equal(response.status, 302)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].stage, stageId)
    assert.equal(entries[0].createdBy, adminId)

    activeUser = {
        ...admin,
        role: "EXECUTIVE",
        permissions: ["movements:read", "orders:read", "ledger:read", "ledger:write"]
    }
    response = await fetch(`${baseUrl}/executive/ledger/new`, { headers })
    assert.equal(response.status, 200)
    assert.match(await response.text(), /Order and next stage/)

    response = await fetch(`${baseUrl}/executive/ledger`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            nextStage: `${orderId}|${stageId}`,
            qtyPcs: "25",
            qtyKgs: "4.5"
        }),
        redirect: "manual"
    })
    assert.equal(response.status, 302)
    assert.equal(entries.length, 2)
})

test("CRM customer and order create, edit, and delete forms work", async (t) => {
    const crmId = "507f1f77bcf86cd799439011"
    const customerId = "507f191e810c19729de860ea"
    const itemId = "507f191e810c19729de860eb"
    const stageId = "507f191e810c19729de860ec"
    const orderId = "507f191e810c19729de860ed"
    const crm = {
        _id: crmId,
        username: "crm-user",
        role: "CRM",
        isActive: true,
        permissions: ["movements:read", "customers:read", "customers:write", "orders:read", "orders:write", "catalog:manage"]
    }
    const customers = [{ _id: customerId, customerUid: "AAAC001", name: "Acme" }]
    const items = [{ _id: itemId, partCode: "PART-1", description: "Part one" }]
    const stages = [{ _id: stageId, processName: "Cutting" }]
    const orders = []
    const originals = {
        authFindOne: AuthSession.findOne,
        userFindById: User.findById,
        customerFind: Customer.find,
        customerFindById: Customer.findById,
        customerCreate: Customer.create,
        customerUpdate: Customer.findByIdAndUpdate,
        customerDelete: Customer.findByIdAndDelete,
        itemFind: Item.find,
        stageFind: Stage.find,
        orderFindById: Order.findById,
        orderCreate: Order.create,
        orderUpdate: Order.findByIdAndUpdate,
        orderDelete: Order.findByIdAndDelete,
        customerExists: Customer.exists,
        itemExists: Item.exists,
        stageCount: Stage.countDocuments,
        orderExists: Order.exists,
        ledgerExists: Ledger.exists,
        ledgerFind: Ledger.find
    }
    t.after(() => {
        AuthSession.findOne = originals.authFindOne
        User.findById = originals.userFindById
        Customer.find = originals.customerFind
        Customer.findById = originals.customerFindById
        Customer.create = originals.customerCreate
        Customer.findByIdAndUpdate = originals.customerUpdate
        Customer.findByIdAndDelete = originals.customerDelete
        Item.find = originals.itemFind
        Stage.find = originals.stageFind
        Order.findById = originals.orderFindById
        Order.create = originals.orderCreate
        Order.findByIdAndUpdate = originals.orderUpdate
        Order.findByIdAndDelete = originals.orderDelete
        Customer.exists = originals.customerExists
        Item.exists = originals.itemExists
        Stage.countDocuments = originals.stageCount
        Order.exists = originals.orderExists
        Ledger.exists = originals.ledgerExists
        Ledger.find = originals.ledgerFind
    })
    const query = (records, sortKey) => ({
        sort() { return this },
        populate() { return this },
        limit() { return this },
        lean: async () => records
    })
    AuthSession.findOne = async () => ({ _id: "session-id", userId: crmId })
    User.findById = async () => crm
    Customer.find = () => query(customers)
    Customer.findById = (id) => ({ lean: async () => customers.find((entry) => String(entry._id) === id) || null })
    Customer.create = async (fields) => {
        const customer = { _id: "507f1f77bcf86cd799439010", customerUid: "AAAC002", ...fields }
        customers.push(customer)
        return customer
    }
    Customer.findByIdAndUpdate = async (id, fields) => {
        const customer = customers.find((entry) => String(entry._id) === id)
        if (customer) Object.assign(customer, fields)
        return customer
    }
    Customer.findByIdAndDelete = async (id) => {
        const index = customers.findIndex((entry) => String(entry._id) === id)
        return index < 0 ? null : customers.splice(index, 1)[0]
    }
    Item.find = () => query(items)
    Stage.find = () => query(stages)
    Order.findById = (id) => ({ lean: async () => orders.find((entry) => String(entry._id) === id) || null })
    Order.create = async (fields) => {
        const order = { _id: orderId, ...fields }
        orders.push(order)
        return order
    }
    Order.findByIdAndUpdate = async (id, fields) => {
        const order = orders.find((entry) => String(entry._id) === id)
        if (order) Object.assign(order, fields)
        return order
    }
    Order.findByIdAndDelete = async (id) => {
        const index = orders.findIndex((entry) => String(entry._id) === id)
        return index < 0 ? null : orders.splice(index, 1)[0]
    }
    Customer.exists = async () => true
    Item.exists = async () => true
    Stage.countDocuments = async () => 1
    Order.exists = async () => null
    Ledger.exists = async () => null
    Ledger.find = () => query([])

    const baseUrl = await startServer(t)
    const headers = { cookie: "sessionId=test-session" }
    let response = await fetch(`${baseUrl}/crm/customers/new`, { headers })
    assert.equal(response.status, 200)
    assert.match(await response.text(), /name="contactPersonName"/)

    response = await fetch(`${baseUrl}/crm/customers`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ name: "New customer", mobile: "555-1234", email: "contact@example.com" }),
        redirect: "manual"
    })
    assert.equal(response.status, 302)
    assert.equal(customers.length, 2)

    response = await fetch(`${baseUrl}/crm/customers/${customerId}/edit`, { headers })
    assert.equal(response.status, 200)
    assert.match(await response.text(), /value="Acme"/)

    response = await fetch(`${baseUrl}/crm/customers/${customerId}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ name: "Acme updated", email: "updated@example.com" }),
        redirect: "manual"
    })
    assert.equal(response.status, 302)
    assert.equal(customers[0].name, "Acme updated")

    response = await fetch(`${baseUrl}/crm/orders/new`, { headers })
    assert.equal(response.status, 200)
    assert.match(await response.text(), /name="stageOrder_507f191e810c19729de860ec"/)

    const orderFields = {
        poNo: "PO-100",
        customer: customerId,
        item: itemId,
        qtyPcs: "100",
        qtyKgs: "25",
        deliveryDate: "2026-12-01",
        [`stageOrder_${stageId}`]: "1"
    }
    response = await fetch(`${baseUrl}/crm/orders`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(orderFields),
        redirect: "manual"
    })
    assert.equal(response.status, 302)
    assert.equal(orders.length, 1)
    assert.deepEqual(orders[0].productionStages, [stageId])

    response = await fetch(`${baseUrl}/crm/orders/${orderId}/edit`, { headers })
    assert.equal(response.status, 200)
    assert.match(await response.text(), /PO-100/)

    response = await fetch(`${baseUrl}/crm/orders/${orderId}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...orderFields, poNo: "PO-101", status: "ON_HOLD" }),
        redirect: "manual"
    })
    assert.equal(response.status, 302)
    assert.equal(orders[0].poNo, "PO-101")
    assert.equal(orders[0].status, "ON_HOLD")

    response = await fetch(`${baseUrl}/crm/orders/${orderId}/delete`, {
        method: "POST",
        headers,
        redirect: "manual"
    })
    assert.equal(response.status, 302)
    assert.equal(orders.length, 0)

    response = await fetch(`${baseUrl}/crm/customers/${customers[0]._id}/delete`, {
        method: "POST",
        headers,
        redirect: "manual"
    })
    assert.equal(response.status, 302)
    assert.equal(customers.length, 1)
})

test("password settings form updates the signed-in account", async (t) => {
    const userId = "507f1f77bcf86cd799439011"
    const originalAuthFindOne = AuthSession.findOne
    const originalUserFindById = User.findById
    const originalSessionDeleteMany = AuthSession.deleteMany
    const originalSessionDeleteOne = AuthSession.deleteOne
    const account = {
        _id: userId,
        role: "ADMIN",
        username: "test-admin",
        isActive: true,
        permissions: ["users:manage"],
        passwordHash: await hashPassword("current-strong-password"),
        async save() {}
    }
    t.after(() => {
        AuthSession.findOne = originalAuthFindOne
        User.findById = originalUserFindById
        AuthSession.deleteMany = originalSessionDeleteMany
        AuthSession.deleteOne = originalSessionDeleteOne
    })
    AuthSession.findOne = async () => ({ _id: "507f191e810c19729de860ef", userId })
    User.findById = () => ({
        select() { return this },
        then(resolve, reject) { return Promise.resolve(account).then(resolve, reject) }
    })
    AuthSession.deleteMany = async () => ({ deletedCount: 0 })
    AuthSession.deleteOne = async () => ({ deletedCount: 0 })

    const baseUrl = await startServer(t)
    const headers = {
        cookie: "sessionId=test-session",
        "content-type": "application/x-www-form-urlencoded"
    }
    let response = await fetch(`${baseUrl}/admin/settings`, { headers: { cookie: headers.cookie } })
    assert.equal(response.status, 200)
    assert.match(await response.text(), /name="currentPassword"/)

    response = await fetch(`${baseUrl}/settings/password`, {
        method: "POST",
        headers,
        body: new URLSearchParams({
            currentPassword: "current-strong-password",
            newPassword: "new-strong-password",
            confirmPassword: "new-strong-password"
        }),
        redirect: "manual"
    })
    assert.equal(response.status, 302)
    assert.match(response.headers.get("location"), /password%20updated/i)
    assert.notEqual(account.passwordHash, "current-strong-password")
})
