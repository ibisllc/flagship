-- A device added by pairing (POST /api/users/:u/devices/admit) was stored with its push service as its platform
-- ("fcm", "apns", "webpush", "unifiedpush"), which the Trusted devices lists do not know and show as "Device".
-- push.ts now maps the push service to the platform; this fixes the rows already written. Re-runnable.
UPDATE device_identities SET platform_class = 'android' WHERE platform_class IN ('fcm', 'unifiedpush');
UPDATE device_identities SET platform_class = 'ios' WHERE platform_class = 'apns';
UPDATE device_identities SET platform_class = 'web' WHERE platform_class = 'webpush';
