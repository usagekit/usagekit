import type { RequestPricingInput } from "../src/priced-request.js";
import { PricedRequest, RequestPricingError } from "../src/priced-request.js";
import {
  executeProviderRequest as execute,
  type ProviderExecution,
  type ProviderExecutionInput,
} from "../src/execute.js";

/** Legacy test setup expressed through the public pricing boundary. Production execution
 * has no overload accepting raw requests. */
export async function executeProviderRequest(
  input: RequestPricingInput & Omit<ProviderExecutionInput, "request">,
): Promise<ProviderExecution> {
  try {
    const request = await PricedRequest.price(input);
    return execute({ ...input, request });
  } catch (error) {
    if (!(error instanceof RequestPricingError)) throw error;
    return {
      outcome: "not_dispatched",
      result: {
        outcome: "invalid",
        field: "request",
        reason: error.message.startsWith("InvalidInput:")
          ? error.message
          : `InvalidInput: ${error.code}`,
      },
    };
  }
}
