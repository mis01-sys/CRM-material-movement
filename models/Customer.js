const mongoose = require("mongoose")
const Counter = require("./Counter")

const customerSchema = new mongoose.Schema({
    customerUid: { type: String, unique: true, immutable: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    address: { type: String, trim: true, maxlength: 500, default: "" },
    mobile: { type: String, trim: true, maxlength: 30, default: "" },
    contactPersonName: { type: String, trim: true, maxlength: 120, default: "" },
    email: { type: String, trim: true, lowercase: true, maxlength: 254, default: "" }
}, { timestamps: true })

customerSchema.pre("validate", async function assignCustomerUid() {
    if (!this.isNew || this.customerUid) {
        return
    }
    const counter = await Counter.findByIdAndUpdate(
        "customerUid",
        { $inc: { sequence: 1 } },
        { new: true, upsert: true, setDefaultsOnInsert: true }
    )
    this.customerUid = `AAAC${String(counter.sequence).padStart(3, "0")}`
})

module.exports = mongoose.model("Customer", customerSchema)
