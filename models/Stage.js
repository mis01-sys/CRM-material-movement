const mongoose = require("mongoose")

const stageSchema = new mongoose.Schema({
    processName: { type: String, required: true, unique: true, trim: true, maxlength: 120 }
}, { timestamps: true })

module.exports = mongoose.model("Stage", stageSchema)
