const test = require("node:test")
const assert = require("node:assert/strict")
const mongoose = require("mongoose")
const Customer = require("../models/Customer")
const Item = require("../models/Item")
const Order = require("../models/Order")
const Ledger = require("../models/Ledger")
const Stage = require("../models/Stage")

test("customer, item, and stage schemas expose their required business fields", () => {
    assert.equal(Customer.schema.path("customerUid").options.unique, true)
    assert.equal(Customer.schema.path("name").options.required, true)
    assert.equal(Item.schema.path("partCode").options.required, true)
    assert.equal(Item.schema.path("description").options.required, true)
    assert.equal(Item.schema.path("variant").instance, "String")
    assert.equal(Stage.schema.path("processName").options.required, true)
})

test("orders require a production route and reference customer, item, and stages", async () => {
    const order = new Order({
        poNo: "PO-100",
        customer: new mongoose.Types.ObjectId(),
        item: new mongoose.Types.ObjectId(),
        qtyPcs: 100,
        qtyKgs: 12.5,
        deliveryDate: new Date(),
        productionStages: []
    })

    await assert.rejects(order.validate(), (error) => Boolean(error.errors.productionStages))
})

test("orders expose open/on-hold CRM status and creator audit references", () => {
    assert.deepEqual(Order.schema.path("status").enumValues, ["OPEN", "ON_HOLD"])
    assert.equal(Order.schema.path("crmUpdatedBy").options.ref, "User")
    assert.equal(Order.schema.path("crmUpdatedAt").defaultValue, null)
})

test("ledger entries capture a timestamp and identify their order, stage, and item", () => {
    const ledger = new Ledger()

    assert.ok(ledger.timestamp instanceof Date)
    assert.equal(Ledger.schema.path("order").options.required, true)
    assert.equal(Ledger.schema.path("stage").options.required, true)
    assert.equal(Ledger.schema.path("item").options.required, true)
    assert.ok(Ledger.schema.indexes().some(([keys, options]) => keys.order === 1 && keys.stage === 1 && options.unique))
})
