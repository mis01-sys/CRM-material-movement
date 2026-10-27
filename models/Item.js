const mongoose = require("mongoose")

const itemSchema = new mongoose.Schema({
    partCode: { type: String, required: true, unique: true, trim: true, uppercase: true, maxlength: 80 },
    description: { type: String, required: true, trim: true, maxlength: 500 },
    variant: { type: String, trim: true, maxlength: 120, default: "" }
}, { timestamps: true })

module.exports = mongoose.model("Item", itemSchema)
