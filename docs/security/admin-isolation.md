# Admin security isolation

Admin uses a separate privileged policy, service identity, approval boundary,
network route, and audit context. Admin actions are not available merely
because a user is authenticated in another app.