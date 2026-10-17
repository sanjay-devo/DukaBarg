"use strict";

const { initializeApp } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");
const { getMessaging } = require("firebase-admin/messaging");
const { getStorage } = require("firebase-admin/storage");
const { HttpsError, onCall } = require("firebase-functions/v2/https");
const { randomUUID } = require("node:crypto");

initializeApp();

const database = getDatabase();
const messaging = getMessaging();
const storageBucket = getStorage().bucket("dukans-flutter-app-free");
const MAX_RECIPIENTS = 5000;
const MAX_BATCH_SIZE = 500;
const TOKEN_FIELDS = ["fcmToken", "deviceToken", "notificationToken"];
const SUPPORTED_SECTIONS = new Set(["categories", "products", "orders", "cart", "profile"]);

function validString(value, maxLength) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function validToken(value) {
  return typeof value === "string" && value.trim().length >= 20 && value.trim().length <= 4096
    ? value.trim()
    : "";
}

function validateNotificationId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new HttpsError("invalid-argument", "A valid notification ID is required.");
  }
}

function collectTokens(uid, profile) {
  const tokens = [];
  const saved = profile.fcmTokens;
  if (Array.isArray(saved)) {
    saved.forEach((entry, index) => {
      const token = validToken(typeof entry === "string" ? entry : entry && entry.token);
      if (token) tokens.push({ uid, token, path: `users/${uid}/fcmTokens/${index}` });
    });
  } else if (saved && typeof saved === "object") {
    Object.entries(saved).forEach(([key, entry]) => {
      const token = validToken(typeof entry === "string" ? entry : entry && entry.token);
      if (token) tokens.push({ uid, token, path: `users/${uid}/fcmTokens/${key}` });
    });
  }
  TOKEN_FIELDS.forEach((field) => {
    const token = validToken(profile[field]);
    if (token) tokens.push({ uid, token, path: `users/${uid}/${field}` });
  });
  return tokens;
}

async function assertAdmin(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in with an administrator account.");
  const role = await database.ref(`users/${request.auth.uid}/role`).get();
  if (!role.exists() || role.val() !== "admin") {
    throw new HttpsError("permission-denied", "Administrator authorization is required.");
  }
}

async function validateDestination(destination) {
  if (!destination || typeof destination !== "object" || Array.isArray(destination)) {
    throw new HttpsError("invalid-argument", "A structured destination is required.");
  }
  if (destination.type === "home") return { type: "home" };
  if (destination.type === "section" && SUPPORTED_SECTIONS.has(destination.section)) {
    return { type: "section", section: destination.section };
  }
  if ((destination.type === "category" || destination.type === "product") &&
      typeof destination.id === "string" && /^[^.#$[\]/]{1,200}$/.test(destination.id)) {
    const root = destination.type === "category" ? "categories" : "products";
    const target = await database.ref(`${root}/${destination.id}`).get();
    if (!target.exists() || !target.val() || typeof target.val() !== "object") {
      throw new HttpsError("invalid-argument", `The selected ${destination.type} no longer exists.`);
    }
    const raw = target.val();
    const name = [raw.name, raw.title, raw.productName, raw.categoryName]
      .find((value) => typeof value === "string" && value.trim()) || destination.id;
    return { type: destination.type, id: destination.id, name: name.trim().slice(0, 200) };
  }
  if (destination.type === "url" && validString(destination.url, 2048)) {
    let url;
    try {
      url = new URL(destination.url);
    } catch {
      throw new HttpsError("invalid-argument", "The external destination URL is invalid.");
    }
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) {
      throw new HttpsError("invalid-argument", "External destinations must use HTTPS and cannot contain credentials.");
    }
    return { type: "url", url: url.href };
  }
  throw new HttpsError("invalid-argument", "The selected destination is not supported.");
}

function validateImageUrl(value) {
  if (value === "" || value == null) return "";
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new HttpsError("invalid-argument", "The notification image URL is invalid.");
  }
  const objectPrefix = `/v0/b/${storageBucket.name}/o/`;
  let objectPath = "";
  try {
    objectPath = decodeURIComponent(url.pathname.slice(objectPrefix.length));
  } catch {
    objectPath = "";
  }
  if (url.protocol !== "https:" ||
      url.hostname !== "firebasestorage.googleapis.com" ||
      !url.pathname.startsWith(objectPrefix) ||
      !objectPath.startsWith("push-notifications/") ||
      !url.searchParams.get("token")) {
    throw new HttpsError("invalid-argument", "Notification images must be uploaded to this Firebase Storage project.");
  }
  return url.href;
}

function imageSignatureMatches(data, contentType) {
  if (contentType === "image/png") {
    return data.length >= 8 &&
      data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  if (contentType === "image/jpeg") {
    return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  }
  return contentType === "image/webp" &&
    data.length >= 12 &&
    data.toString("ascii", 0, 4) === "RIFF" &&
    data.toString("ascii", 8, 12) === "WEBP";
}

exports.uploadPushNotificationImage = onCall({ maxInstances: 5, timeoutSeconds: 120 }, async (request) => {
  await assertAdmin(request);
  const { base64, contentType, fileName } = request.data || {};
  if (!["image/png", "image/jpeg", "image/webp"].includes(contentType) ||
      typeof base64 !== "string" || base64.length > 1.5 * 1024 * 1024 ||
      !validString(fileName, 150)) {
    throw new HttpsError("invalid-argument", "Choose a PNG, JPEG, or WebP image no larger than 1 MB.");
  }
  const data = Buffer.from(base64, "base64");
  if (!data.length || data.length > 1024 * 1024 ||
      data.toString("base64") !== base64 ||
      !imageSignatureMatches(data, contentType)) {
    throw new HttpsError("invalid-argument", "The image is invalid or exceeds 1 MB.");
  }
  const safeName = fileName.replace(/[^A-Za-z0-9._-]/g, "_").slice(-100) || "notification-image";
  const path = `push-notifications/${request.auth.uid}/${randomUUID()}-${safeName}`;
  const downloadToken = randomUUID();
  const file = storageBucket.file(path);
  await file.save(data, {
    resumable: false,
    metadata: {
      contentType,
      metadata: { firebaseStorageDownloadTokens: downloadToken },
    },
  });
  return {
    path,
    url: `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(storageBucket.name)}/o/${encodeURIComponent(path)}?alt=media&token=${downloadToken}`,
  };
});

exports.deletePushNotificationImage = onCall({ maxInstances: 5 }, async (request) => {
  await assertAdmin(request);
  const path = request.data && request.data.path;
  if (typeof path !== "string" ||
      !path.startsWith(`push-notifications/${request.auth.uid}/`) ||
      path.includes("..") || path.length > 300) {
    throw new HttpsError("invalid-argument", "The image path is invalid.");
  }
  await storageBucket.file(path).delete({ ignoreNotFound: true });
  return { deleted: true };
});

function recipientUidsFromProfiles(profiles, scope, requestedUids) {
  const customerUids = Object.entries(profiles)
    .filter(([uid, profile]) => profile && typeof profile === "object" &&
      !Array.isArray(profile) && profile.role === "customer" && profile.uid === uid)
    .map(([uid]) => uid);
  if (scope === "all") return customerUids;
  if (scope !== "selected" || !Array.isArray(requestedUids) ||
      requestedUids.length === 0 || requestedUids.length > MAX_RECIPIENTS) {
    throw new HttpsError("invalid-argument", "Select at least one valid consumer.");
  }
  const requested = [...new Set(requestedUids)];
  if (requested.some((uid) => typeof uid !== "string" || !customerUids.includes(uid))) {
    throw new HttpsError("invalid-argument", "Selected recipients must be existing consumer accounts.");
  }
  return requested;
}

function fcmErrorText(error) {
  const code = typeof error?.code === "string" ? error.code : "messaging/unknown-error";
  return `${code}: ${String(error?.message || "FCM did not accept this token.").slice(0, 300)}`;
}

async function removeInvalidToken(entry, code) {
  if (!["messaging/registration-token-not-registered", "messaging/invalid-registration-token"].includes(code)) {
    return;
  }
  const tokenRef = database.ref(entry.path);
  await tokenRef.transaction((current) => {
    const currentToken = typeof current === "string" ? current : current && current.token;
    return currentToken === entry.token ? null : undefined;
  });
}

exports.sendPushNotification = onCall({ region: "us-central1", maxInstances: 5, timeoutSeconds: 540 }, async (request) => {
  await assertAdmin(request);
  const data = request.data || {};
  validateNotificationId(data.notificationId);
  if (!validString(data.title, 100) || !validString(data.body, 500) ||
      (data.subtitle != null && (typeof data.subtitle !== "string" || data.subtitle.length > 120))) {
    throw new HttpsError("invalid-argument", "Title and message are required and must meet their character limits.");
  }
  const destination = await validateDestination(data.destination);
  const imageUrl = validateImageUrl(data.imageUrl);
  const usersSnapshot = await database.ref("users").get();
  const profiles = usersSnapshot.val() || {};
  const recipientUids = recipientUidsFromProfiles(profiles, data.recipientScope, data.recipientUids);
  if (!recipientUids.length || recipientUids.length > MAX_RECIPIENTS) {
    throw new HttpsError("failed-precondition", "There are no valid consumer accounts in this recipient group.");
  }

  const recipients = Object.fromEntries(recipientUids.map((uid) => [uid, {
    status: "send_requested",
    requestedAt: Date.now(),
  }]));
  const entriesByToken = new Map();
  const recipientResults = Object.create(null);
  recipientUids.forEach((uid) => {
    const tokens = collectTokens(uid, profiles[uid]);
    if (!tokens.length) {
      recipientResults[uid] = { status: "failed", error: "No valid registered FCM token.", completedAt: Date.now() };
      return;
    }
    tokens.forEach((entry) => {
      if (!entriesByToken.has(entry.token)) entriesByToken.set(entry.token, []);
      entriesByToken.get(entry.token).push(entry);
    });
  });

  const recordRef = database.ref(`pushNotifications/${data.notificationId}`);
  const record = {
    title: data.title.trim(),
    subtitle: typeof data.subtitle === "string" ? data.subtitle.trim() : "",
    body: data.body.trim(),
    imageUrl,
    destination,
    recipientScope: data.recipientScope,
    createdBy: request.auth.uid,
    createdAt: Date.now(),
    sentAt: Date.now(),
    status: "send_requested",
    intendedRecipientCount: recipientUids.length,
    fcmAcceptedCount: 0,
    failedRecipientCount: 0,
    uniqueOpens: 0,
    recipients,
  };
  const claim = await recordRef.transaction((existing) => existing === null ? record : undefined);
  if (!claim.committed) {
    throw new HttpsError("already-exists", "This notification ID has already been processed; it was not sent again.");
  }

  const tokenEntries = [...entriesByToken.entries()];
  const staleTokenCleanups = [];
  let unknownBatchCount = 0;
  const destinationData = JSON.stringify(destination);
  for (let offset = 0; offset < tokenEntries.length; offset += MAX_BATCH_SIZE) {
    const batch = tokenEntries.slice(offset, offset + MAX_BATCH_SIZE);
    const message = {
      tokens: batch.map(([token]) => token),
      notification: {
        title: record.title,
        body: record.body,
        ...(imageUrl ? { imageUrl } : {}),
      },
      data: {
        notificationId: data.notificationId,
        destination: destinationData,
        subtitle: record.subtitle,
      },
      android: {
        priority: "high",
        notification: imageUrl ? { imageUrl } : {},
      },
    };
    try {
      const result = await messaging.sendEachForMulticast(message);
      const acceptedInBatch = new Set();
      result.responses.forEach((response, index) => {
        const [token, owners] = batch[index];
        owners.forEach(({ uid }) => {
          const previous = recipientResults[uid];
          if (!previous || previous.status !== "accepted") {
            recipientResults[uid] = response.success
              ? { status: "accepted", acceptedAt: Date.now() }
              : { status: "failed", error: fcmErrorText(response.error), completedAt: Date.now() };
          }
          if (response.success) acceptedInBatch.add(uid);
        });
        if (!response.success) {
          const code = response.error?.code;
          if (code) {
            owners.filter((owner) => owner.token === token).forEach((stale) => {
              staleTokenCleanups.push(removeInvalidToken(stale, code).catch((error) => {
              console.error("Unable to remove an invalid FCM token.", error);
              }));
            });
          }
        }
      });
      if (acceptedInBatch.size) {
        const acceptedAt = Date.now();
        await recordRef.child("recipients").update(Object.fromEntries(
          [...acceptedInBatch].map((uid) => [uid, { status: "accepted", acceptedAt }]),
        ));
      }
    } catch (error) {
      unknownBatchCount += 1;
      console.error("FCM multicast batch failed before a response was received.", error);
      batch.forEach(([, owners]) => owners.forEach(({ uid }) => {
        if (!recipientResults[uid] || recipientResults[uid].status !== "accepted") {
          recipientResults[uid] = { status: "unknown", error: "FCM batch outcome could not be confirmed; do not retry this notification ID.", completedAt: Date.now() };
        }
      }));
    }
  }
  await Promise.all(staleTokenCleanups);

  recipientUids.forEach((uid) => {
    if (!recipientResults[uid]) {
      recipientResults[uid] = { status: "failed", error: "No FCM response was recorded.", completedAt: Date.now() };
    }
  });
  const acceptedUids = recipientUids.filter((uid) => recipientResults[uid].status === "accepted");
  const failedUids = recipientUids.filter((uid) => recipientResults[uid].status !== "accepted");
  const status = acceptedUids.length === recipientUids.length
    ? "fcm_accepted"
    : acceptedUids.length > 0 || unknownBatchCount > 0
      ? "partial_failure"
      : "failed";
  const updates = {
    status,
    fcmAcceptedCount: acceptedUids.length,
    failedRecipientCount: failedUids.length,
    completedAt: Date.now(),
    recipients: recipientResults,
  };
  await recordRef.update(updates);
  return {
    notificationId: data.notificationId,
    status,
    intendedRecipientCount: recipientUids.length,
    fcmAcceptedCount: acceptedUids.length,
    failedRecipientCount: failedUids.length,
  };
});

exports.recordNotificationOpen = onCall({ maxInstances: 10 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in before recording a notification open.");
  const notificationId = request.data && request.data.notificationId;
  validateNotificationId(notificationId);
  const uid = request.auth.uid;
  const notificationRef = database.ref(`pushNotifications/${notificationId}`);
  const notificationSnapshot = await notificationRef.get();
  if (!notificationSnapshot.exists()) {
    throw new HttpsError("not-found", "The notification does not exist.");
  }
  const recipient = notificationSnapshot.child(`recipients/${uid}`).val();
  if (!recipient || !["accepted", "opened"].includes(recipient.status)) {
    throw new HttpsError("permission-denied", "This account is not an accepted recipient of the notification.");
  }
  const openRef = database.ref(`pushNotificationOpens/${notificationId}/${uid}`);
  const open = await openRef.transaction((existing) => existing === null
    ? { openedAt: Date.now() }
    : undefined);
  if (open.committed) {
    await notificationRef.child("uniqueOpens").transaction((count) =>
      Number.isSafeInteger(count) && count >= 0 ? count + 1 : 1);
  }
  await notificationRef.child(`recipients/${uid}`).update({
    status: "opened",
    openedAt: open.snapshot.val().openedAt,
  });
  return { recorded: true, unique: open.committed };
});
