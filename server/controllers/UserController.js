import razorpay from "razorpay";
import stripe from "stripe";
import { Webhook } from "svix";
import transactionModel from "../models/transactionModel.js";
import userModel from "../models/userModel.js";

// Gateway Initialize
const stripeInstance = process.env.STRIPE_SECRET_KEY
    ? new stripe(process.env.STRIPE_SECRET_KEY)
    : null;

const razorpayInstance = process.env.RAZORPAY_KEY_ID
    ? new razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET,
    })
    : null;

// API Controller Function to Manage Clerk User with Database
const clerkWebhooks = async (req, res) => {
    try {
        const whook = new Webhook(process.env.CLERK_WEBHOOK_SECRET);

        await whook.verify(JSON.stringify(req.body), {
            "svix-id": req.headers["svix-id"],
            "svix-timestamp": req.headers["svix-timestamp"],
            "svix-signature": req.headers["svix-signature"],
        });

        const { data, type } = req.body;

        switch (type) {
            case "user.created":
                const newUser = {
                    clerkId: data.id,
                    email: data.email_addresses[0].email_address,
                    firstName: data.first_name,
                    lastName: data.last_name,
                    photo: data.image_url,
                };
                await userModel.create(newUser);
                res.json({});
                break;

            case "user.updated":
                const updatedUser = {
                    email: data.email_addresses[0].email_address,
                    firstName: data.first_name,
                    lastName: data.last_name,
                    photo: data.image_url,
                };
                await userModel.findOneAndUpdate({ clerkId: data.id }, updatedUser);
                res.json({});
                break;

            case "user.deleted":
                await userModel.findOneAndDelete({ clerkId: data.id });
                res.json({});
                break;

            default:
                res.json({});
        }
    } catch (error) {
        console.log(error.message);
        res.status(500).json({ success: false, message: error.message });
    }
};

// API Controller Function to Get User Available Credits Data
const userCredits = async (req, res) => {
    try {
        const { clerkId } = req.body;
        const userData = await userModel.findOne({ clerkId });
        res.json({ success: true, credits: userData.creditBalance });
    } catch (error) {
        console.log(error.message);
        res.status(500).json({ success: false, message: error.message });
    }
};

// Payment API to Add Credits (Razorpay)
const paymentRazorpay = async (req, res) => {
    try {
        const { clerkId, planId } = req.body;
        const userData = await userModel.findOne({ clerkId });

        if (!userData || !planId) {
            return res.json({ success: false, message: "Invalid Credentials" });
        }

        const plans = {
            Basic: { credits: 100, amount: 10 },
            Advanced: { credits: 500, amount: 50 },
            Business: { credits: 5000, amount: 250 },
        };

        const plan = plans[planId];
        if (!plan) {
            return res.json({ success: false, message: "Plan not found" });
        }

        const transactionData = await transactionModel.create({
            clerkId,
            plan: planId,
            amount: plan.amount,
            credits: plan.credits,
            date: Date.now(),
        });

        const options = {
            amount: plan.amount * 100,
            currency: process.env.CURRENCY,
            receipt: transactionData._id.toString(),
        };

        const order = await razorpayInstance.orders.create(options);
        res.json({ success: true, order });
    } catch (error) {
        console.log(error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// API Controller Function to Verify Razorpay Payment
const verifyRazorpay = async (req, res) => {
    try {
        const { razorpay_order_id } = req.body;
        const orderInfo = await razorpayInstance.orders.fetch(razorpay_order_id);

        if (orderInfo.status === "paid") {
            const transactionData = await transactionModel.findById(orderInfo.receipt);

            if (transactionData.payment) {
                return res.json({ success: false, message: "Payment Already Verified" });
            }

            const userData = await userModel.findOne({ clerkId: transactionData.clerkId });
            const creditBalance = userData.creditBalance + transactionData.credits;
            await userModel.findByIdAndUpdate(userData._id, { creditBalance });
            await transactionModel.findByIdAndUpdate(transactionData._id, { payment: true });

            res.json({ success: true, message: "Credits Added" });
        } else {
            res.json({ success: false, message: "Payment Failed" });
        }
    } catch (error) {
        console.log(error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// Payment API to Add Credits (Stripe)
const paymentStripe = async (req, res) => {
    try {
        const { clerkId, planId } = req.body;
        const { origin } = req.headers;

        const userData = await userModel.findOne({ clerkId });

        if (!userData || !planId) {
            return res.json({ success: false, message: "Invalid Credentials" });
        }

        const plans = {
            Basic: { credits: 100, amount: 10 },
            Advanced: { credits: 500, amount: 50 },
            Business: { credits: 5000, amount: 250 },
        };

        const plan = plans[planId];
        if (!plan) {
            return res.json({ success: false, message: "Plan not found" });
        }

        const transactionData = await transactionModel.create({
            clerkId,
            plan: planId,
            amount: plan.amount,
            credits: plan.credits,
            date: Date.now(),
        });

        const line_items = [
            {
                price_data: {
                    currency: process.env.CURRENCY.toLowerCase(),
                    product_data: { name: "Credit Purchase" },
                    unit_amount: plan.amount * 100,
                },
                quantity: 1,
            },
        ];

        const session = await stripeInstance.checkout.sessions.create({
            success_url: `${origin}/verify?success=true&transactionId=${transactionData._id}`,
            cancel_url: `${origin}/verify?success=false&transactionId=${transactionData._id}`,
            line_items,
            mode: "payment",
        });

        res.json({ success: true, session_url: session.url });
    } catch (error) {
        console.log(error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// API Controller Function to Verify Stripe Payment
const verifyStripe = async (req, res) => {
    try {
        const { transactionId, success } = req.body;

        if (success === "true") {
            const transactionData = await transactionModel.findById(transactionId);

            if (transactionData.payment) {
                return res.json({ success: false, message: "Payment Already Verified" });
            }

            const userData = await userModel.findOne({ clerkId: transactionData.clerkId });
            const creditBalance = userData.creditBalance + transactionData.credits;
            await userModel.findByIdAndUpdate(userData._id, { creditBalance });
            await transactionModel.findByIdAndUpdate(transactionData._id, { payment: true });

            res.json({ success: true, message: "Credits Added" });
        } else {
            res.json({ success: false, message: "Payment Failed" });
        }
    } catch (error) {
        console.log(error);
        res.status(500).json({ success: false, message: error.message });
    }
};

export { clerkWebhooks, paymentRazorpay, paymentStripe, userCredits, verifyRazorpay, verifyStripe };

