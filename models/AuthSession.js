const mongoose = require("mongoose")

const authSessionSchema = new mongoose.Schema({
    sessionIdHash: { type: String, required: true, unique: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    expiresAt: { type: Date, required: true, index: { expires: 0 } }
}, { timestamps: true })

module.exports = mongoose.model("AuthSession", authSessionSchema)
