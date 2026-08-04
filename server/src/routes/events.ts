import { Router } from "express";
import { getEvent, listEvents, updateEventStatus } from "../store/eventStore.js";
import { getMessage } from "../store/messageStore.js";
import { pushEventToCalendar } from "../services/pipeline.js";

export const eventsRouter = Router();

eventsRouter.get("/", (req, res) => {
  const limit = Number(req.query.limit ?? 100);
  res.json(listEvents(limit));
});

eventsRouter.post("/:id/create", async (req, res) => {
  const id = Number(req.params.id);
  const event = getEvent(id);
  if (!event) {
    res.status(404).json({ error: "Event not found" });
    return;
  }
  const message = getMessage(event.messageId);
  if (!message) {
    res.status(404).json({ error: "Source message not found" });
    return;
  }
  const updated = await pushEventToCalendar(event, message);
  res.json(updated);
});

eventsRouter.post("/:id/dismiss", (req, res) => {
  const id = Number(req.params.id);
  const event = getEvent(id);
  if (!event) {
    res.status(404).json({ error: "Event not found" });
    return;
  }
  updateEventStatus(id, "dismissed");
  res.json(getEvent(id));
});
