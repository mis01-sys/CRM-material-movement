const mongoose = require("mongoose")

const orderSchema = new mongoose.Schema({
    poNo: { type: String, required: true, unique: true, trim: true, uppercase: true, maxlength: 80 },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
    item: { type: mongoose.Schema.Types.ObjectId, ref: "Item", required: true },
    qtyPcs: { type: Number, required: true, min: 0 },
    qtyKgs: { type: Number, required: true, min: 0 },
    deliveryDate: { type: Date, required: true },
    status: { type: String, enum: ["OPEN", "ON_HOLD"], default: "OPEN" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    crmUpdatedAt: { type: Date, default: null },
    crmUpdatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    productionStages: {
        type: [{ type: mongoose.Schema.Types.ObjectId, ref: "Stage", required: true }],
        validate: { validator: (stages) => stages.length > 0, message: "At least one production stage is required" }
    }
}, { timestamps: true })

orderSchema.index({ customer: 1, deliveryDate: 1 })

module.exports = mongoose.model("Order", orderSchema)
