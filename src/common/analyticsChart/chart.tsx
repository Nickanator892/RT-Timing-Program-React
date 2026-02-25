import { useEffect, useRef } from "react";
import "./chart.css";
import Chart from "react-apexcharts";
import type { ApexOptions } from "apexcharts";
import useTimes from "../../hooks/loggedTimesHook";
import { useMemo } from "react";

interface chartData {
    loggedTimes: {
        seconds: number;
        formattedTime: string;
    }[];
    harnNumber: string;
    buildNumber: number;
    buildTimeEst: {
        seconds: number;
        formattedTime: string;
    };
    currentTimeSeconds: string;
}

interface seriesSettings {
    name: string;
    data: { x: string; y: number }[];
}

interface chartPlots {
    loggedTimes: {
        x: string;
        y: number;
    }[];
}

function AnalyticsChart({
    loggedTimes,
    harnNumber,
    buildNumber,
    buildTimeEst,
    currentTimeSeconds,
}: chartData) {
    const chartData = loggedTimes.length > 0
        ? loggedTimes.map((time, i) => ({
            x: `Build ${i + 1}`,
            y: parseFloat((time.seconds / 60).toFixed(2)),
        }))
        : [{ x: "No builds yet", y: 0 }];

    function calculateSeconds(timeString: string): number {
        if (!timeString || typeof timeString !== "string") {
            return 0;
        }

        try {
            const [hours, minutes, seconds] = timeString.split(":").map(Number);
            return hours * 3600 + minutes * 60 + seconds;
        } catch (error) {
            console.error("Error parsing time string:", timeString, error);
            return 0;
        }
    }

    const currentTimeMinutes = useMemo(() => {
        const minutes = calculateSeconds(currentTimeSeconds) / 60;
        return minutes;
    }, [currentTimeSeconds]);

    const series = [
        {
            name: "Sessions",
            data: chartData,
        },
    ];

    const estimateMinutes = buildTimeEst.seconds / 60;

    const allValues = [...chartData.map((d) => d.y), estimateMinutes, currentTimeMinutes];
    const yMax = Math.ceil(Math.max(...allValues) * 1.2);

    const apexOptions: ApexOptions = useMemo(
        () => ({
            chart: {
                type: "line",
                toolbar: { show: false },
                foreColor: "#FFFFFF",
                animations: {
                    enabled: true,
                    dynamicAnimation: {
                        enabled: true,
                        speed: 350,
                    },
                },
            },
            title: {
                text: "Build Analytics",
                align: "center",
                style: {
                    fontSize: "25px",
                    fontFamily: "Orbitron",
                },
            },
            xaxis: {
                type: "category",
                labels: {
                    rotateAlways: true,
                    rotate: -45,
                    offsetY: 10,
                },
            },
            yaxis: {
                min: 0,
                max: yMax,
                title: {
                    text: "Minutes",
                    style: {
                        fontSize: "25px",
                        fontFamily: "Orbitron",
                    },
                },
            },
            annotations: {
                yaxis: [
                    {
                        y: buildTimeEst.seconds / 60,
                        borderColor: "#F527F5",
                        strokeDashArray: 0,
                        borderWidth: 2,
                        label: {
                            borderColor: "#FF4560",
                            style: {
                                color: "#FFFFFF",
                                background: "#000000",
                            },
                            text: "Estimated Time",
                        },
                    },
                    {
                        y: currentTimeMinutes,
                        borderColor: "#FF4560",
                        strokeDashArray: 5,
                        borderWidth: 2,
                        label: {
                            borderColor: "#FF4560",
                            style: {
                                color: "#FFFFFF",
                                background: "#000000",
                            },
                            text: `Current: ${currentTimeSeconds}`,
                        },
                    },
                ],
            },
            stroke: {
                curve: "straight",
                width: 3,
            },
            colors: ["#27F546"],
            markers: {
                size: 8,
            },
        }),
        [currentTimeMinutes, buildTimeEst.seconds, currentTimeSeconds]
    );

    function AnalyticsChart({
        loggedTimes,
        harnNumber,
        buildNumber,
        buildTimeEst,
        currentTimeSeconds,
    }: chartData) {
        const chartRef = useRef<any>(null);

        // ... your existing code ...

        // Update annotations when currentTimeMinutes changes
        useEffect(() => {
            if (chartRef.current && chartRef.current.chart) {
                chartRef.current.chart.updateOptions({
                    annotations: {
                        yaxis: [
                            {
                                y: buildTimeEst.seconds / 60,
                                borderColor: "#F527F5",
                                strokeDashArray: 0,
                                borderWidth: 2,
                                label: {
                                    borderColor: "#FF4560",
                                    style: {
                                        color: "#FFFFFF",
                                        background: "#000000",
                                    },
                                    text: "Estimated Time",
                                },
                            },
                            {
                                y: currentTimeMinutes,
                                borderColor: "#FF4560",
                                strokeDashArray: 5,
                                borderWidth: 2,
                                label: {
                                    borderColor: "#FF4560",
                                    style: {
                                        color: "#FFFFFF",
                                        background: "#000000",
                                    },
                                    text: `Current: ${currentTimeSeconds}`,
                                },
                            },
                        ],
                    },
                });
            }
        }, [currentTimeMinutes, currentTimeSeconds, buildTimeEst.seconds]);
    }

    return (
        <div className="chart">
            <Chart options={apexOptions} series={series} type="line" height="100%" width="100%" />
        </div>
    );
}

export default AnalyticsChart;
