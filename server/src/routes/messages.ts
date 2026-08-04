import { Router } from "express";
import { listMessages } from "../store/messageStore.js";

export const messagesRouter = Router();

messagesRouter.get("/", (req, res) => {
  const limit = Number(req.query.limit ?? 100);
  res.json(listMessages(limit));
});
