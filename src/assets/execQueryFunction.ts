export const execQuery = async (
    requestedQuery: string,
    params: unknown[] = []
): Promise<unknown> => {
    console.log(requestedQuery);
    try {
        const response = await fetch("http://localhost:5000/api/query", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: requestedQuery, params }),
        });
        console.log(`RESPONSE: ${response}`);
        const data = await response.json();

        if (data.success === false) {
            return;
        }
        const dataToReturn: unknown = data.result;
        return dataToReturn;
    } catch (err: any) {
        console.log(err);
    }
};
