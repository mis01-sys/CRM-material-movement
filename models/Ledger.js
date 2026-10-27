const mongoose = require("mongoose")

const ledgerSchema = new mongoose.Schema({
    order: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true },
    stage: { type: mongoose.Schema.Types.ObjectId, ref: "Stage", required: true },
    item: { type: mongoose.Schema.Types.ObjectId, ref: "Item", required: true },
    qtyKgs: { type: Number, required: true, min: 0 },
    qtyPcs: { type: Number, required: true, min: 0 },
    timestamp: { type: Date, required: true, default: Date.now },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }
}, { timestamps: true })

ledgerSchema.index({ order: 1, timestamp: -1, createdAt: -1 })
ledgerSchema.index({ order: 1, stage: 1 }, { unique: true })

module.exports = mongoose.model("Ledger", ledgerSchema)
