# AI / Agent / ZYNTH service

Transport boundary for AI capabilities. Domain handlers, tool permissions, and
owned schema adapters are enabled only after their migration gates pass.
Clients call the gateway, not this process directly.

Operational endpoints are provided by `@ayzen/service-runtime`.