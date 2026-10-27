const express = require("express")
const mongoose = require("mongoose")
const Customer = require("../models/Customer")
const Item = require("../models/Item")
const Stage = require("../models/Stage")
const Order = require("../models/Order")
const Ledger = require("../models/Ledger")
const User = require("../models/User")
const { requireAuth } = require("../middlewares/auth")
const { requirePermission, requireRole } = require("../middlewares/authorization")

const router = express.Router()
const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next)
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const isId = (value) => mongoose.Types.ObjectId.isValid(value)
const validIdList = (value) => Array.isArray(value) && value.length > 0 && value.every(isId)
const validEmail = (value) => value === undefined || value === "" || (
    typeof value === "string" && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
)

router.use(requireAuth)

router.get("/dashboard", requirePermission("movements:read"), requireRole("CRM", "EXECUTIVE", "ADMIN"), wrap(async (req, res) => {
    const now = new Date()
    const [customerCount, itemCount, orderCount, stageCount, ledgerCount, upcomingCount, users, orders, recentLedger] = await Promise.all([
        Customer.countDocuments(),
        Item.countDocuments(),
        Order.countDocuments(),
        Stage.countDocuments(),
        Ledger.countDocuments(),
        Order.countDocuments({ deliveryDate: { $gte: now } }),
        req.user.role === "ADMIN" ? User.find().select("username role isActive lastLoginAt").sort({ role: 1, username: 1 }).lean() : Promise.resolve([]),
        Order.find().populate("customer", "name customerUid").populate("item", "partCode description variant")
            .populate("productionStages", "processName")
            .populate("updatedBy", "username role").populate("crmUpdatedBy", "username")
            .sort({ deliveryDate: 1 }).limit(250).lean(),
        Ledger.find().populate("order", "poNo").populate("stage", "processName").populate("item", "partCode").populate("createdBy", "username").sort({ timestamp: -1 }).limit(8).lean()
    ])
    const latestLedger = orders.length ? await Ledger.find({ order: { $in: orders.map((order) => order._id) } })
        .populate("stage", "processName").populate("createdBy", "username")
        .sort({ timestamp: -1, createdAt: -1 }).lean() : []
    const latestByOrder = new Map()
    for (const entry of latestLedger) {
        const key = String(entry.order)
        if (!latestByOrder.has(key)) latestByOrder.set(key, entry)
    }
    const enrichedOrders = orders.map((order) => {
        const latestUpdate = latestByOrder.get(String(order._id))
        const lastStageId = latestUpdate && String(latestUpdate.stage?._id)
        const completedStages = lastStageId
            ? Math.max(0, order.productionStages.findIndex((stage) => String(stage._id) === lastStageId) + 1)
            : 0
        const workflowStatus = completedStages >= order.productionStages.length
            ? "COMPLETE"
            : completedStages > 0 ? "IN_PRODUCTION" : "NEW"
        return {
            ...order,
            completedStages,
            workflowStatus: order.status === "ON_HOLD" ? "ON_HOLD" : workflowStatus,
            lastExecutiveUpdate: latestUpdate ? {
                stage: latestUpdate.stage,
                timestamp: latestUpdate.timestamp,
                createdBy: latestUpdate.createdBy
            } : null
        }
    })
    const latestCrmUpdates = enrichedOrders.filter((order) => order.crmUpdatedBy)
        .sort((first, second) => new Date(second.crmUpdatedAt) - new Date(first.crmUpdatedAt))
        .slice(0, 8)
    res.json({
        metrics: { customerCount, itemCount, orderCount, stageCount, ledgerCount, upcomingCount },
        users,
        orders: enrichedOrders.sort((first, second) => new Date(first.deliveryDate) - new Date(second.deliveryDate)).slice(0, 250),
        recentLedger,
        latestCrmUpdates
    })
}))

router.get("/customers", requirePermission("customers:read"), requireRole("CRM", "EXECUTIVE", "ADMIN"), wrap(async (req, res) => {
    const filter = {}
    if (typeof req.query.q === "string" && req.query.q.trim()) {
        const query = new RegExp(escapeRegex(req.query.q.trim()), "i")
        filter.$or = [{ customerUid: query }, { name: query }, { mobile: query }, { email: query }, { contactPersonName: query }]
    }
    const customers = await Customer.find(filter).sort({ name: 1 }).limit(250).lean()
    res.json({ customers })
}))

router.post("/customers", requirePermission("customers:write"), requireRole("CRM", "ADMIN"), wrap(async (req, res) => {
    const { name, address, mobile, contactPersonName, email } = req.body || {}
    if (typeof name !== "string" || !name.trim()) {
        return res.status(400).json({ message: "Customer name is required" })
    }
    if (!validEmail(email)) return res.status(400).json({ message: "Enter a valid customer email address" })
    const customer = await Customer.create({ name, address, mobile, contactPersonName, email })
    return res.status(201).json({ customer })
}))

router.patch("/customers/:id", requirePermission("customers:write"), requireRole("CRM", "ADMIN"), wrap(async (req, res) => {
    if (!isId(req.params.id)) return res.status(400).json({ message: "Invalid customer ID" })
    const updates = {}
    for (const field of ["name", "address", "mobile", "contactPersonName", "email"]) {
        if (req.body && req.body[field] !== undefined) updates[field] = req.body[field]
    }
    if (!Object.keys(updates).length) return res.status(400).json({ message: "No customer fields to update" })
    if (!validEmail(updates.email)) return res.status(400).json({ message: "Enter a valid customer email address" })
    const customer = await Customer.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true })
    if (!customer) return res.status(404).json({ message: "Customer not found" })
    return res.json({ customer })
}))

router.delete("/customers/:id", requirePermission("customers:write"), requireRole("CRM", "ADMIN"), wrap(async (req, res) => {
    if (!isId(req.params.id)) return res.status(400).json({ message: "Invalid customer ID" })
    if (await Order.exists({ customer: req.params.id })) return res.status(409).json({ message: "Customer is linked to existing orders" })
    const customer = await Customer.findByIdAndDelete(req.params.id)
    if (!customer) return res.status(404).json({ message: "Customer not found" })
    return res.status(204).end()
}))

router.get("/items", requirePermission("movements:read"), requireRole("CRM", "ADMIN"), wrap(async (req, res) => {
    const filter = {}
    if (typeof req.query.q === "string" && req.query.q.trim()) {
        const query = new RegExp(escapeRegex(req.query.q.trim()), "i")
        filter.$or = [{ partCode: query }, { description: query }, { variant: query }]
    }
    res.json({ items: await Item.find(filter).sort({ partCode: 1 }).limit(250).lean() })
}))

router.post("/items", requirePermission("catalog:manage"), requireRole("CRM", "ADMIN"), wrap(async (req, res) => {
    const { partCode, description, variant } = req.body || {}
    if (typeof partCode !== "string" || !partCode.trim() || typeof description !== "string" || !description.trim()) {
        return res.status(400).json({ message: "Part code and description are required" })
    }
    return res.status(201).json({ item: await Item.create({ partCode, description, variant }) })
}))

router.patch("/items/:id", requirePermission("catalog:manage"), requireRole("CRM", "ADMIN"), wrap(async (req, res) => {
    if (!isId(req.params.id)) return res.status(400).json({ message: "Invalid item ID" })
    const updates = {}
    for (const field of ["partCode", "description", "variant"]) {
        if (req.body && req.body[field] !== undefined) updates[field] = req.body[field]
    }
    if (!Object.keys(updates).length) return res.status(400).json({ message: "No item fields to update" })
    const item = await Item.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true })
    if (!item) return res.status(404).json({ message: "Item not found" })
    return res.json({ item })
}))

router.delete("/items/:id", requirePermission("catalog:manage"), requireRole("CRM", "ADMIN"), wrap(async (req, res) => {
    if (!isId(req.params.id)) return res.status(400).json({ message: "Invalid item ID" })
    if (await Order.exists({ item: req.params.id })) return res.status(409).json({ message: "Item is linked to existing orders" })
    const item = await Item.findByIdAndDelete(req.params.id)
    if (!item) return res.status(404).json({ message: "Item not found" })
    return res.status(204).end()
}))

router.get("/stages", requirePermission("movements:read"), requireRole("CRM", "ADMIN"), wrap(async (req, res) => {
    const filter = {}
    if (typeof req.query.q === "string" && req.query.q.trim()) filter.processName = new RegExp(escapeRegex(req.query.q.trim()), "i")
    res.json({ stages: await Stage.find(filter).sort({ processName: 1 }).limit(250).lean() })
}))

router.post("/stages", requirePermission("catalog:manage"), requireRole("ADMIN"), wrap(async (req, res) => {
    const { processName } = req.body || {}
    if (typeof processName !== "string" || !processName.trim()) return res.status(400).json({ message: "Process name is required" })
    return res.status(201).json({ stage: await Stage.create({ processName }) })
}))

router.patch("/stages/:id", requirePermission("catalog:manage"), requireRole("ADMIN"), wrap(async (req, res) => {
    if (!isId(req.params.id)) return res.status(400).json({ message: "Invalid stage ID" })
    if (typeof req.body?.processName !== "string" || !req.body.processName.trim()) return res.status(400).json({ message: "Process name is required" })
    const stage = await Stage.findByIdAndUpdate(req.params.id, { processName: req.body.processName }, { new: true, runValidators: true })
    if (!stage) return res.status(404).json({ message: "Stage not found" })
    return res.json({ stage })
}))

router.delete("/stages/:id", requirePermission("catalog:manage"), requireRole("ADMIN"), wrap(async (req, res) => {
    if (!isId(req.params.id)) return res.status(400).json({ message: "Invalid stage ID" })
    if (await Order.exists({ productionStages: req.params.id }) || await Ledger.exists({ stage: req.params.id })) {
        return res.status(409).json({ message: "Stage is referenced by an order or production entry" })
    }
    const stage = await Stage.findByIdAndDelete(req.params.id)
    if (!stage) return res.status(404).json({ message: "Stage not found" })
    return res.status(204).end()
}))

router.get("/orders", requirePermission("orders:read"), requireRole("CRM", "EXECUTIVE", "ADMIN"), wrap(async (req, res) => {
    const filter = {}
    if (typeof req.query.q === "string" && req.query.q.trim()) {
        const query = new RegExp(escapeRegex(req.query.q.trim()), "i")
        const [customers, items] = await Promise.all([
            Customer.find({ $or: [{ name: query }, { customerUid: query }] }).select("_id"),
            Item.find({ $or: [{ partCode: query }, { description: query }] }).select("_id")
        ])
        filter.$or = [{ poNo: query }, { customer: { $in: customers.map(({ _id }) => _id) } }, { item: { $in: items.map(({ _id }) => _id) } }]
    }
    const orders = await Order.find(filter).populate("customer", "name customerUid").populate("item", "partCode description variant").populate("productionStages", "processName")
        .populate("crmUpdatedBy", "username").populate("updatedBy", "username role")
        .sort({ deliveryDate: 1 }).limit(250).lean()
    const orderIds = orders.map(({ _id }) => _id)
    const entries = orderIds.length ? await Ledger.find({ order: { $in: orderIds } }).populate("stage", "processName")
        .populate("createdBy", "username").sort({ timestamp: -1, createdAt: -1 }).lean() : []
    const latestByOrder = new Map()
    for (const entry of entries) {
        const key = String(entry.order)
        if (!latestByOrder.has(key)) latestByOrder.set(key, entry)
    }
    const withProgress = orders.map((order) => {
        const latestUpdate = latestByOrder.get(String(order._id))
        const lastStage = latestUpdate && String(latestUpdate.stage?._id)
        const completedStages = lastStage ? Math.max(0, order.productionStages.findIndex((stage) => String(stage._id) === lastStage) + 1) : 0
        const derivedStatus = completedStages >= order.productionStages.length ? "COMPLETE" : completedStages ? "IN_PRODUCTION" : "NEW"
        return {
            ...order,
            completedStages,
            workflowStatus: order.status === "ON_HOLD" ? "ON_HOLD" : derivedStatus,
            lastExecutiveUpdate: latestUpdate ? {
                stage: latestUpdate.stage,
                timestamp: latestUpdate.timestamp,
                createdBy: latestUpdate.createdBy
            } : null
        }
    })
    return res.json({ orders: withProgress })
}))

const validateOrder = async (payload) => {
    if (typeof payload.poNo !== "string" || !payload.poNo.trim()) return "PO number is required"
    if (!isId(payload.customer) || !isId(payload.item)) return "A valid customer and item are required"
    if (!Number.isFinite(Number(payload.qtyPcs)) || Number(payload.qtyPcs) < 0 || !Number.isFinite(Number(payload.qtyKgs)) || Number(payload.qtyKgs) < 0) {
        return "Quantities must be zero or greater"
    }
    if (!payload.deliveryDate || Number.isNaN(Date.parse(payload.deliveryDate))) return "A valid delivery date is required"
    if (!validIdList(payload.productionStages) || new Set(payload.productionStages.map(String)).size !== payload.productionStages.length) {
        return "Select at least one valid, non-repeating production stage"
    }
    const [customer, item, stages] = await Promise.all([
        Customer.exists({ _id: payload.customer }),
        Item.exists({ _id: payload.item }),
        Stage.countDocuments({ _id: { $in: payload.productionStages } })
    ])
    if (!customer || !item || stages !== payload.productionStages.length) return "Customer, item, and all production stages must exist"
    return null
}

router.post("/orders", requirePermission("orders:write"), requireRole("CRM", "ADMIN"), wrap(async (req, res) => {
    const error = await validateOrder(req.body || {})
    if (error) return res.status(400).json({ message: error })
    const order = await Order.create({
        poNo: req.body.poNo,
        customer: req.body.customer,
        item: req.body.item,
        qtyPcs: req.body.qtyPcs,
        qtyKgs: req.body.qtyKgs,
        deliveryDate: req.body.deliveryDate,
        productionStages: req.body.productionStages,
        createdBy: req.user._id,
        updatedBy: req.user._id,
        ...(req.user.role === "CRM" ? { crmUpdatedBy: req.user._id, crmUpdatedAt: new Date() } : {})
    })
    return res.status(201).json({ order })
}))

router.patch("/orders/:id", requirePermission("orders:write"), requireRole("CRM", "ADMIN"), wrap(async (req, res) => {
    if (!isId(req.params.id)) return res.status(400).json({ message: "Invalid order ID" })
    const current = await Order.findById(req.params.id).lean()
    if (!current) return res.status(404).json({ message: "Order not found" })
    const hasProductionHistory = await Ledger.exists({ order: req.params.id })
    const requestedFields = Object.keys(req.body || {}).filter((field) => field !== "status")
    if (hasProductionHistory && requestedFields.length) {
        return res.status(409).json({ message: "Orders with production activity can only have their order status changed" })
    }
    const payload = { ...current, ...(req.body || {}) }
    const error = await validateOrder(payload)
    if (error) return res.status(400).json({ message: error })
    if (payload.status !== undefined && !["OPEN", "ON_HOLD"].includes(payload.status)) {
        return res.status(400).json({ message: "Status must be OPEN or ON_HOLD" })
    }
    const fields = ["poNo", "customer", "item", "qtyPcs", "qtyKgs", "deliveryDate", "productionStages", "status"]
    const unknownField = Object.keys(req.body || {}).find((field) => !fields.includes(field))
    if (unknownField) return res.status(400).json({ message: `Unsupported order field: ${unknownField}` })
    if (!fields.some((field) => req.body?.[field] !== undefined)) return res.status(400).json({ message: "Provide at least one order field to update" })
    const updates = Object.fromEntries(fields.filter((field) => req.body?.[field] !== undefined).map((field) => [field, req.body[field]]))
    updates.updatedBy = req.user._id
    if (req.user.role === "CRM") {
        updates.crmUpdatedBy = req.user._id
        updates.crmUpdatedAt = new Date()
    }
    const order = await Order.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true })
    return res.json({ order })
}))

router.delete("/orders/:id", requirePermission("orders:write"), requireRole("CRM", "ADMIN"), wrap(async (req, res) => {
    if (!isId(req.params.id)) return res.status(400).json({ message: "Invalid order ID" })
    if (await Ledger.exists({ order: req.params.id })) return res.status(409).json({ message: "Orders with production activity cannot be deleted" })
    const order = await Order.findByIdAndDelete(req.params.id)
    if (!order) return res.status(404).json({ message: "Order not found" })
    return res.status(204).end()
}))

router.get("/ledger", requirePermission("ledger:read"), requireRole("CRM", "ADMIN"), wrap(async (req, res) => {
    const filter = {}
    if (req.query.order && isId(req.query.order)) filter.order = req.query.order
    if (typeof req.query.q === "string" && req.query.q.trim()) {
        const query = new RegExp(escapeRegex(req.query.q.trim()), "i")
        const orders = await Order.find({ poNo: query }).select("_id")
        const stages = await Stage.find({ processName: query }).select("_id")
        const items = await Item.find({ partCode: query }).select("_id")
        filter.$or = [
            { order: { $in: orders.map(({ _id }) => _id) } },
            { stage: { $in: stages.map(({ _id }) => _id) } },
            { item: { $in: items.map(({ _id }) => _id) } }
        ]
    }
    const ledger = await Ledger.find(filter).populate("order", "poNo").populate("stage", "processName").populate("item", "partCode description").populate("createdBy", "username").sort({ timestamp: -1 }).limit(300).lean()
    return res.json({ ledger })
}))

router.post("/ledger", requirePermission("ledger:write"), requireRole("EXECUTIVE", "ADMIN"), wrap(async (req, res) => {
    const { order: orderId, stage: stageId, qtyKgs, qtyPcs } = req.body || {}
    if (!isId(orderId) || !isId(stageId)) return res.status(400).json({ message: "Select a valid order and stage" })
    if (!Number.isFinite(Number(qtyKgs)) || Number(qtyKgs) < 0 || !Number.isFinite(Number(qtyPcs)) || Number(qtyPcs) < 0) {
        return res.status(400).json({ message: "Quantities must be zero or greater" })
    }
    const order = await Order.findById(orderId)
    if (!order) return res.status(404).json({ message: "Order not found" })
    if (order.status === "ON_HOLD") return res.status(409).json({ message: "This order is on hold. Ask CRM to reopen it before recording production." })
    if (!order.productionStages.some((stage) => String(stage) === stageId)) return res.status(400).json({ message: "Stage is not part of this order's production route" })
    const prior = await Ledger.findOne({ order: orderId }).sort({ timestamp: -1, createdAt: -1 }).select("stage").lean()
    const expectedIndex = prior ? order.productionStages.findIndex((stage) => String(stage) === String(prior.stage)) + 1 : 0
    if (expectedIndex >= order.productionStages.length || String(order.productionStages[expectedIndex]) !== stageId) {
        return res.status(409).json({ message: "Production stages must be recorded in the order's configured sequence" })
    }
    const ledger = await Ledger.create({
        order: order._id,
        stage: stageId,
        item: order.item,
        qtyKgs,
        qtyPcs,
        createdBy: req.user._id
    })
    return res.status(201).json({ ledger })
}))

module.exports = router
