# Acceso Meta Review

Configurar `META_REVIEW_EMAIL` y `META_REVIEW_PASSWORD` crea la cuenta de
revisión al iniciar. Es idempotente: los siguientes arranques conservan su
contraseña y restauran su rol y asociación al cliente fijo.

No existe registro público. Las cuentas viven en PostgreSQL en
`botly_gateway_users` y sólo un `admin` autenticado puede crear, deshabilitar o
restablecer contraseñas de usuarios.

En cada inicio, el Gateway garantiza la existencia del cliente fijo **Meta
Review**. Tiene un ID determinístico y aislado; no se crea duplicado ni se
relaciona con clientes operativos.

Al crear una cuenta con rol `meta_reviewer`, el servidor ignora cualquier
`business_id` enviado y le asigna automáticamente ese cliente fijo. El reviewer
puede listar, crear y gestionar todas las conexiones pertenecientes a Meta
Review, incluyendo el flujo de Embedded Signup con cualquier WABA y teléfono
que Meta autorice. No se requiere lista de WABAs en configuración.

El reviewer no puede acceder a Dashboard, Alertas, Settings, usuarios ni a
ningún cliente o conexión que no pertenezca a Meta Review. El backend valida la
propiedad de la conexión en todas las rutas `/connections/{id}/...`, no sólo en
la interfaz.

Para retirar el acceso, un administrador deshabilita la cuenta con
`PATCH /auth/users/{id}/disable`; las sesiones vigentes se invalidan en la
siguiente solicitud. Para resetear una contraseña se usa
`PATCH /auth/users/{id}/password`.
